# /// script
# requires-python = ">=3.13"
# dependencies = ["PyYAML==6.0.3"]
# ///
"""Rehearse fresh-state cutover using generated fixtures only. No existing state is accepted."""
import argparse
from contextlib import ExitStack
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import threading
import time
from urllib.parse import unquote, urlsplit
import uuid

from archive import archive_fixture, digest, require, restore_fixture, verify_archive

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'rust/scripts'))
from release_archive import extract_release, validate_release
from node_bridges import verify_node

WAIT = 30


def write_private(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as file:
        file.write(value)


def run(args, env, *, cwd=None, timeout=WAIT, check=True):
    result = subprocess.run([str(a) for a in args], env=env, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if check:
        require(result.returncode == 0, f'fixture command {Path(args[0]).name} failed: {result.stderr[-2000:]}')
    return result


class Service:
    def __init__(self, args, env, log):
        self.log = log.open('wb')
        self.process = subprocess.Popen([str(a) for a in args], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=self.log, start_new_session=True)
        lines = queue.Queue()
        threading.Thread(target=lambda: lines.put(self.process.stdout.readline().decode().strip()), daemon=True).start()
        try:
            self.ready = lines.get(timeout=WAIT)
            require(bool(self.ready) and self.process.poll() is None, 'fixture service did not become ready')
        except BaseException:
            self.stop()
            raise

    def stop(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            try:
                self.process.wait(timeout=WAIT)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=10)
                raise ValueError('fixture service required forced termination')
        self.process.stdout.close()
        self.log.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.stop()


def endpoint(line):
    value = line if line.startswith('http://') else 'http://' + line
    parsed = urlsplit(value)
    require(parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', '::1') and parsed.port, 'fixture endpoint must be loopback')
    return value


class Postgres:
    def __init__(self, url_file, tools, env):
        parsed = urlsplit(url_file.read_text().strip())
        require(parsed.scheme in ('postgres', 'postgresql') and parsed.hostname and not parsed.query and not parsed.fragment, 'test database binding must use a plain PostgreSQL URL')
        require(parsed.hostname == 'localhost' or ipaddress.ip_address(parsed.hostname).is_loopback, 'rehearsal database must be a local test server')
        self.env = {**env, 'PGHOST': parsed.hostname, 'PGPORT': str(parsed.port or 5432), 'PGUSER': unquote(parsed.username or ''), 'PGPASSWORD': unquote(parsed.password or ''), 'PGDATABASE': unquote(parsed.path.lstrip('/')), 'PGCONNECT_TIMEOUT': '10'}
        self.tools, self.created, self.marker = tools, [], 'synthetic-cutover:' + str(uuid.uuid4())
        self.base = parsed
        version = int(self.sql('SHOW server_version_num;').strip()) // 10000
        dump_version = run([tools / 'pg_dump', '--version'], env).stdout
        require(int(re.search(r'(\d+)\.', dump_version)[1]) >= version, 'pg_dump must support the test server version')

    def sql(self, text, env=None):
        return run([self.tools / 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', text], env or self.env).stdout

    def create(self):
        name = 'supertag_cutover_' + uuid.uuid4().hex
        self.sql(f'CREATE DATABASE "{name}";')
        try:
            self.sql(f"COMMENT ON DATABASE \"{name}\" IS '{self.marker}';")
        except BaseException:
            self.sql(f'DROP DATABASE \"{name}\";')
            raise
        self.created.append(name)
        return name

    def binding(self, name):
        require(name in self.created, 'database is not owned by rehearsal')
        return self.base._replace(path='/' + name).geturl()

    def dump(self, name, destination):
        require(name in self.created, 'database is not owned by rehearsal')
        run([self.tools / 'pg_dump', '--format=custom', '--no-owner', '--no-privileges', '--file', destination], {**self.env, 'PGDATABASE': name}, timeout=120)
        destination.chmod(0o600)

    def restore(self, name, archive):
        require(name in self.created, 'database is not owned by rehearsal')
        run([self.tools / 'pg_restore', '--exit-on-error', '--no-owner', '--no-privileges', '--dbname', name, archive], {**self.env, 'PGDATABASE': name}, timeout=120)

    def close(self):
        for name in reversed(self.created):
            marker = self.sql(f"SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = '{name}';").strip()
            require(marker == self.marker, 'test database ownership changed; refusing cleanup')
            self.sql(f'DROP DATABASE "{name}" WITH (FORCE);')
        self.created.clear()


def legacy(node, source, action, directory, url, env, log):
    binding = directory.parent / (directory.name + '-binding')
    write_private(binding, url)
    try:
        response = run([node, '--import', 'tsx', '--conditions=development', source / 'tests/rust-port-cutover/legacy.ts', action, directory, binding], env, cwd=source, timeout=90)
        log.write_text(response.stdout + response.stderr)
        lines = [line.removeprefix('CUTOVER_LEGACY ') for line in response.stdout.splitlines() if line.startswith('CUTOVER_LEGACY ')]
        require(len(lines) == 1, 'legacy fixture did not emit one final receipt')
        return json.loads(lines[0])
    finally:
        binding.unlink()


def workspace(root, env):
    root.mkdir(mode=0o700)
    run(['git', 'init', '-q', root], env)
    (root / 'report.txt').write_text('Committed legacy workspace evidence\n')
    run(['git', '-C', root, 'add', 'report.txt'], env)
    run(['git', '-C', root, '-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Legacy fixture'], env)
    revision = run(['git', '-C', root, 'rev-parse', 'HEAD'], env).stdout.strip()
    (root / 'report.txt').write_text('Uncommitted legacy operator changes\n')
    (root / 'untracked.txt').write_text('Do not lose this file\n')
    return revision


def fresh_runtime(cli, fixture, root, env, old, pg=None):
    root.mkdir(mode=0o700)
    fresh_env = {**env, 'HOME': str(root)}
    state = root / 'state'
    with ExitStack() as stack:
        if pg is None:
            server = stack.enter_context(Service([cli, 'up', '--foreground', '--adapter', fixture, '--state-directory', state], fresh_env, root / 'up.log'))
            endpoint(server.ready)
            connection = ['--state-directory', state]
        else:
            name = pg.create()
            gateway_token, operator_token, host_token = (str(uuid.uuid4()) for _ in range(3))
            control = stack.enter_context(Service([cli, 'control-plane'], {**fresh_env, 'SUPERTAG_DATABASE_URL': pg.binding(name), 'SUPERTAG_GATEWAY_TOKEN': gateway_token, 'SUPERTAG_BOOTSTRAP_HOST_TOKEN': host_token}, root / 'control.log'))
            gateway = stack.enter_context(Service([cli, 'gateway', '--control-plane', endpoint(control.ready)], {**fresh_env, 'SUPERTAG_GATEWAY_TOKEN': gateway_token, 'SUPERTAG_OPERATOR_TOKEN': operator_token, 'SUPERTAG_HOST_TOKEN': host_token}, root / 'gateway.log'))
            public = endpoint(gateway.ready)
            host = stack.enter_context(Service([cli, 'worker-host', '--gateway', public, '--state-directory', state, '--adapter', fixture], {**fresh_env, 'SUPERTAG_HOST_TOKEN': host_token}, root / 'host.log'))
            require(host.ready == 'ready', 'fresh Worker Host did not report readiness')
            connection = ['--gateway', public]
            fresh_env['SUPERTAG_OPERATOR_TOKEN'] = operator_token
        def invoke(*args, check=True):
            response = run([cli, *args, *connection], fresh_env, check=check)
            return json.loads(response.stdout) if check else response
        roster = invoke('get', 'tags')
        require(roster['tags'] == [], 'fresh runtime inherited old identities')
        require(invoke('get', 'task', old['taskId'], check=False).returncode != 0, 'fresh runtime imported old Task history')
        tag = invoke('tag', 'put', 'fresh-engineer', '--instructions', 'Complete synthetic cutover Tasks', '--allow', 'files:read')
        require(tag['tag_id'] != old['tagId'], 'fresh Tag reused old identity')
        task = invoke('task', 'submit', '--tag', 'fresh-engineer', '--session', 'fresh-session', 'Fresh cutover work')
        until = time.monotonic() + WAIT
        while True:
            task = invoke('get', 'task', task['task_id'])
            if task['state'] in ('TASK_STATE_SUCCEEDED', 'TASK_STATE_FAILED'):
                break
            require(time.monotonic() < until, 'fresh runtime did not complete synthetic work')
            time.sleep(0.05)
        require(task['state'] == 'TASK_STATE_SUCCEEDED' and 'Fresh cutover work' in task['result'], 'fresh Task failed')
        require(task['task_id'] != old['taskId'] and task['session_id'] != old['sessionId'], 'fresh Task reused legacy identity')
        require(not (state / 'host-journal').exists() and not (state / 'native-sessions').exists(), 'legacy runtime files entered fresh state')
    return {'emptyInitialRoster': True, 'oldTaskAbsent': True, 'newIdentityAndSession': True, 'newTaskSucceeded': True, 'servicesStoppedBeforeLegacyRestore': True, 'taskId': task['task_id']}


def rehearse(args):
    output = args.output.resolve()
    require(not output.exists(), 'output must be a new disposable directory')
    output.mkdir(mode=0o700)
    scratch = output / 'scratch'
    scratch.mkdir(mode=0o700)
    home = scratch / 'home'
    home.mkdir(mode=0o700)
    node, pnpm = args.node.resolve(strict=True), args.pnpm.resolve(strict=True)
    verify_node(node)
    env = {'PATH': str(node.parent) + ':' + str(pnpm.parent) + ':' + os.environ.get('PATH', os.defpath), 'HOME': str(home), 'LANG': 'C.UTF-8', 'CI': 'true', 'GIT_CONFIG_NOSYSTEM': '1'}
    commit = args.legacy_commit
    require(re.fullmatch('[0-9a-f]{40}', commit), 'legacy source requires a full commit hash')
    source_archive = output / 'legacy-source.tar'
    run(['git', '-C', REPO, 'archive', '--format=tar', '-o', source_archive, commit], env)
    source_archive.chmod(0o600)
    source = scratch / 'legacy-runtime'
    with tarfile.open(source_archive) as archive:
        archive.extractall(source, filter='data')
    package = json.loads((source / 'package.json').read_text())
    manager = run([pnpm, '--version'], env, cwd=source).stdout.strip()
    require(package['packageManager'] == 'pnpm@' + manager, 'pnpm version must match the archived legacy source')
    fixture_dir = source / 'tests/rust-port-cutover'
    fixture_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(Path(__file__).with_name('legacy.ts'), fixture_dir / 'legacy.ts')
    install = run([pnpm, 'install', '--prefer-offline', '--frozen-lockfile'], env, cwd=source, timeout=180)
    (output / 'legacy-dependencies.log').write_text(install.stdout + install.stderr)
    with tarfile.open(source_archive) as archive:
        for member in archive:
            if member.isfile():
                require((source / member.name).read_bytes() == archive.extractfile(member).read(), 'legacy source input changed during dependency setup: ' + member.name)
    release = {'commit': commit, 'version': package['version'], 'sourceArchiveSha256': digest(source_archive), 'node': run([node, '--version'], env).stdout.strip(), 'packageManager': package['packageManager'], 'lockfileSha256': digest(source / 'pnpm-lock.yaml')}
    manifest = validate_release(args.rust_archive)
    native = extract_release(args.rust_archive, scratch / 'native-release')
    fixture = args.fixture_adapter.resolve(strict=True)
    require(fixture.is_file() and os.access(fixture, os.X_OK), 'synthetic adapter executable required')
    pg = Postgres(args.postgres_url_file, args.pg_bin, env)
    reports = {}
    try:
        for backend in ('sqlite', 'postgresql'):
            case = scratch / backend
            case.mkdir(mode=0o700)
            old = case / 'legacy-state'
            old.mkdir(mode=0o700)
            old_db = pg.create() if backend == 'postgresql' else None
            url = pg.binding(old_db) if old_db else 'file:' + str(old / 'state.sqlite')
            seeded = legacy(node, source, 'seed', old, url, env, output / (backend + '-seed.log'))
            require(seeded['writersStopped'] and seeded['status'] == 'completed' and seeded['executions'] == 1, 'legacy work did not drain before archive')
            revision = workspace(old / 'workspace', env)
            if old_db:
                pg.dump(old_db, old / 'database.dump')
            archived = output / (backend + '-legacy.tar')
            deployment = {'syntheticOnly': True, 'writers_stopped': True, 'externalIngress': 'not configured', 'connectorConsumers': [], 'legacyRelease': release, 'backend': backend, 'drainedTaskId': seeded['taskId'], 'configurationSha256': digest(old / 'configuration.json'), 'workspaceCommit': revision}
            sha = archive_fixture(old, archived, deployment)
            write_private(Path(str(archived) + '.sha256'), sha + '\n')
            verify_archive(archived, sha)
            fresh = fresh_runtime(native / 'supertag', fixture, case / 'fresh-rust', env, seeded, pg if old_db else None)
            # Restore only after all fresh-runtime process scopes have exited.
            restored = case / 'restored-legacy'
            restore_fixture(archived, restored, sha)
            restore_db = pg.create() if old_db else None
            if restore_db:
                pg.restore(restore_db, restored / 'database.dump')
            restored_url = pg.binding(restore_db) if restore_db else 'file:' + str(restored / 'state.sqlite')
            recovered = legacy(node, source, 'restore', restored, restored_url, env, output / (backend + '-restore.log'))
            require(recovered['writersStopped'] and recovered['executions'] == 0, 'restored work unexpectedly executed')
            require(run(['git', '-C', restored / 'workspace', 'rev-parse', 'HEAD'], env).stdout.strip() == revision, 'restored Git ancestry differs')
            require((restored / 'workspace/report.txt').read_text() == 'Uncommitted legacy operator changes\n' and (restored / 'workspace/untracked.txt').read_text() == 'Do not lose this file\n', 'restored workspace changes differ')
            require(digest(archived) == sha, 'restoration changed the preserved archive')
            verify_archive(archived, sha)
            reports[backend] = {'archiveSha256': sha, 'legacy': recovered, 'freshRust': fresh, 'workspaceRestored': True, 'archiveUnchanged': True}
    finally:
        pg.close()
    receipt = {'format': 'supertag-synthetic-cutover-rehearsal-v1', 'legacyRelease': release, 'rustRelease': {'source': manifest['source'], 'version': manifest['version'], 'platform': manifest['platform'], 'archiveSha256': digest(args.rust_archive)}, 'fixtureAdapterSha256': digest(fixture), 'backends': reports, 'realProviderCalls': False, 'existingStateRead': False, 'legacyHistoryImported': False, 'testDatabasesRemoved': not pg.created, 'limits': ['Synthetic native Session state, not provider validation', 'No external ingress or connector consumers were configured', 'No production rollout, legacy retirement or reconciliation of new external effects']}
    shutil.rmtree(scratch)
    receipt['scratchRemoved'] = not scratch.exists()
    write_private(output / 'receipt.json', json.dumps(receipt, indent=2, sort_keys=True) + '\n')
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--legacy-commit', required=True)
    parser.add_argument('--rust-archive', type=Path, required=True)
    parser.add_argument('--fixture-adapter', type=Path, required=True)
    parser.add_argument('--postgres-url-file', type=Path, required=True)
    parser.add_argument('--pg-bin', type=Path, required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--pnpm', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = rehearse(args)
        print(json.dumps({'receipt': str(args.output.resolve() / 'receipt.json'), 'backends': list(result['backends']), 'passed': True}))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f'fresh-state rehearsal: {error}\n')


if __name__ == '__main__':
    main()
