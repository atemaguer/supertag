//! Git delivery against a local bare repository: pinning, relayed source, both landing modes,
//! conflicts, refusals, and `workspace check`.
use std::{
    path::{Path, PathBuf},
    process::Command,
};

use sha2::{Digest, Sha256};
use supertag_credential_vault::CredentialVault;
use supertag_git_delivery::{Access, Credentials, GitDelivery, Remote, landing::Outcome};

/// The landing's remote, which needs no credential in these tests.
fn remote(landing: &supertag_protocol::v2::WorkspaceLanding) -> Remote {
    Remote::new(&landing.remote, None).unwrap()
}
use supertag_protocol::v2::{
    BlobReference, Workspace, WorkspaceCheckStatus, WorkspaceDeliveryReference, WorkspaceLand,
    WorkspaceLandMerge, WorkspaceLanding, WorkspaceLandingMode, workspace_land,
};
use tokio_util::sync::CancellationToken;

fn git(directory: &Path, args: &[&str]) -> String {
    let output = Command::new("/usr/bin/git")
        .current_dir(directory)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Ada")
        .env("GIT_AUTHOR_EMAIL", "ada@example.com")
        .env("GIT_COMMITTER_NAME", "Ada")
        .env("GIT_COMMITTER_EMAIL", "ada@example.com")
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

struct Fixture {
    state: PathBuf,
    _root: tempfile::TempDir,
    remote: PathBuf,
    work: PathBuf,
    delivery: GitDelivery,
    base: String,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let remote = root.path().join("remote.git");
        let work = root.path().join("work");
        std::fs::create_dir(&remote).unwrap();
        git(
            &remote,
            &["init", "--bare", "--quiet", "--initial-branch=main"],
        );
        git(
            root.path(),
            &["init", "--quiet", "--initial-branch=main", "work"],
        );
        std::fs::write(work.join("notes.md"), "line one\nline two\n").unwrap();
        git(&work, &["add", "."]);
        git(&work, &["commit", "--quiet", "-m", "base"]);
        let base = git(&work, &["rev-parse", "HEAD"]);
        git(
            &work,
            &["push", "--quiet", remote.to_str().unwrap(), "main"],
        );
        let state = root.path().join("state");
        let vault_directory = state.clone();
        let vault = CredentialVault::from_environment(move |key| {
            (key == "SUPERTAG_STATE_DIR").then(|| vault_directory.display().to_string())
        })
        .unwrap();
        let delivery =
            GitDelivery::new(&state.join("git-delivery"), Credentials::new(vault)).unwrap();
        Self {
            state,
            _root: root,
            remote,
            work,
            delivery,
            base,
        }
    }

    fn url(&self) -> String {
        format!("file://{}", self.remote.canonicalize().unwrap().display())
    }

    fn workspace(&self, land: Option<workspace_land::Mode>) -> Workspace {
        Workspace {
            workspace_id: "handbook".into(),
            remote: self.url(),
            r#ref: "main".into(),
            land: land.map(|mode| WorkspaceLand { mode: Some(mode) }),
            ..Default::default()
        }
    }

    /// A Session commit on top of the base, changing `notes.md`, delivered as a bundle.
    fn session(&self, name: &str, content: &str) -> (String, PathBuf, BlobReference) {
        git(&self.work, &["checkout", "--quiet", "-B", name, &self.base]);
        std::fs::write(self.work.join("notes.md"), content).unwrap();
        git(&self.work, &["commit", "--quiet", "-am", name]);
        let head = git(&self.work, &["rev-parse", "HEAD"]);
        let bundle = self.work.parent().unwrap().join(format!("{name}.bundle"));
        git(
            &self.work,
            &[
                "bundle",
                "create",
                "--quiet",
                bundle.to_str().unwrap(),
                &format!("refs/heads/{name}"),
            ],
        );
        let bytes = std::fs::read(&bundle).unwrap();
        let blob = BlobReference {
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            byte_length: bytes.len() as u64,
        };
        (head, bundle, blob)
    }

    /// A commit someone else pushed to `branch` on the remote.
    fn push_other(&self, branch: &str, file: &str, content: &str) -> String {
        git(
            &self.work,
            &[
                "checkout",
                "--quiet",
                "-B",
                &format!("other-{branch}"),
                &self.base,
            ],
        );
        std::fs::write(self.work.join(file), content).unwrap();
        git(&self.work, &["add", "."]);
        git(&self.work, &["commit", "--quiet", "-m", "other"]);
        git(
            &self.work,
            &[
                "push",
                "--quiet",
                "--force",
                self.remote.to_str().unwrap(),
                &format!("HEAD:refs/heads/{branch}"),
            ],
        );
        git(&self.work, &["rev-parse", "HEAD"])
    }

    fn remote_ref(&self, branch: &str) -> String {
        git(
            &self.remote,
            &["rev-parse", &format!("refs/heads/{branch}")],
        )
    }

    fn landing(
        &self,
        mode: WorkspaceLandingMode,
        head: &str,
        blob: BlobReference,
    ) -> WorkspaceLanding {
        WorkspaceLanding {
            landing_id: "landing".into(),
            task_id: "task-1".into(),
            tag_id: "docs".into(),
            session_id: "work/notes".into(),
            workspace_id: "handbook".into(),
            remote: self.url(),
            mode: mode as i32,
            branch: supertag_protocol::session_branch("docs", "work/notes"),
            target: "drafts".into(),
            delivery: Some(WorkspaceDeliveryReference {
                workspace_id: "handbook".into(),
                delivery_id: "delivery".into(),
                base_commit: self.base.clone(),
                start_commit: self.base.clone(),
                head_commit: head.into(),
                committed: true,
                bundle: Some(blob),
                ..Default::default()
            }),
            author_name: "Docs".into(),
            author_email: "docs@noreply.supertag.invalid".into(),
            co_author: "ada <ada@noreply.supertag.invalid>".into(),
            ..Default::default()
        }
    }
}

#[tokio::test]
async fn sessions_start_from_a_pinned_commit_relayed_as_a_bundle() {
    let fixture = Fixture::new();
    let cancel = CancellationToken::new();
    let mut workspace = fixture.workspace(None);
    workspace.r#ref.clear();
    let (branch, commit) = fixture.delivery.resolve(&workspace, &cancel).await.unwrap();
    assert_eq!(
        (branch.as_str(), commit.as_str()),
        ("main", fixture.base.as_str())
    );
    workspace.r#ref = "missing".into();
    let error = fixture
        .delivery
        .resolve(&workspace, &cancel)
        .await
        .unwrap_err();
    assert!(
        format!("{error:#}").contains("no branch missing"),
        "{error:#}"
    );

    workspace.r#ref = "main".into();
    workspace.resolved_ref = "main".into();
    // The Control Plane grants the read; the Worker Host, with no credential vault, fetches.
    let grant = fixture
        .delivery
        .grant(&workspace, Access::Read)
        .await
        .unwrap();
    let host_directory = tempfile::tempdir().unwrap();
    let host = GitDelivery::for_host(&host_directory.path().join("git")).unwrap();
    let fetched = host
        .fetch(&workspace, &fixture.base, grant.credential.clone(), &cancel)
        .await
        .unwrap();
    let heads = git(
        fixture.work.as_path(),
        &[
            "bundle",
            "list-heads",
            fetched.bundle.path.to_str().unwrap(),
        ],
    );
    assert!(heads.starts_with(&fixture.base), "{heads}");
    assert_eq!(
        fixture
            .delivery
            .advertised_output_remote(&workspace, &fixture.base, &cancel)
            .await
            .unwrap(),
        Some(fixture.url())
    );

    // Git LFS is refused with a clear reason rather than delivering pointer files.
    std::fs::write(
        fixture.work.join(".gitattributes"),
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    )
    .unwrap();
    git(&fixture.work, &["add", "."]);
    git(&fixture.work, &["commit", "--quiet", "-m", "lfs"]);
    git(
        &fixture.work,
        &["push", "--quiet", fixture.remote.to_str().unwrap(), "main"],
    );
    let lfs = git(&fixture.work, &["rev-parse", "HEAD"]);
    let error = host
        .fetch(&workspace, &lfs, grant.credential, &cancel)
        .await
        .err()
        .unwrap();
    assert!(format!("{error:#}").contains("Git LFS"), "{error:?}");
}

#[tokio::test]
async fn branch_mode_pushes_the_session_branch_fast_forward_only() {
    let fixture = Fixture::new();
    let cancel = CancellationToken::new();
    let (head, bundle, blob) = fixture.session("first", "line one\nchanged\n");
    let landing = fixture.landing(WorkspaceLandingMode::Branch, &head, blob);
    let outcome = fixture
        .delivery
        .land(&landing, &remote(&landing), &bundle, &cancel)
        .await
        .unwrap();
    assert_eq!(outcome, Outcome::Landed(head.clone()));
    assert_eq!(fixture.remote_ref(&landing.branch), head);
    // Landing the same commit again changes nothing.
    let again = fixture
        .delivery
        .land(&landing, &remote(&landing), &bundle, &cancel)
        .await
        .unwrap();
    assert_eq!(again, Outcome::Landed(head));

    // A Session branch someone rewrote is never overwritten.
    fixture.push_other(&landing.branch, "other.md", "rewritten\n");
    let (next, bundle, blob) = fixture.session("second", "line one\nagain\n");
    let landing = fixture.landing(WorkspaceLandingMode::Branch, &next, blob);
    match fixture
        .delivery
        .land(&landing, &remote(&landing), &bundle, &cancel)
        .await
        .unwrap()
    {
        Outcome::Held(reason) => assert!(reason.contains("never force-pushes"), "{reason}"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn merge_mode_merges_into_the_target_with_the_tag_as_author() {
    let fixture = Fixture::new();
    let cancel = CancellationToken::new();
    let (head, bundle, blob) = fixture.session("merge", "line one\nline two\nadded\n");
    let landing = fixture.landing(WorkspaceLandingMode::Merge, &head, blob);

    // The first Session to land creates a missing target.
    let outcome = fixture
        .delivery
        .land(&landing, &remote(&landing), &bundle, &cancel)
        .await
        .unwrap();
    assert_eq!(outcome, Outcome::Landed(head.clone()));
    assert_eq!(fixture.remote_ref("drafts"), head);

    // A target that moved on is merged with a merge commit, never rebased.
    let other = fixture.push_other("drafts", "other.md", "someone else\n");
    let outcome = fixture
        .delivery
        .land(&landing, &remote(&landing), &bundle, &cancel)
        .await
        .unwrap();
    let Outcome::Landed(merged) = outcome else {
        panic!("{outcome:?}")
    };
    assert_eq!(fixture.remote_ref("drafts"), merged);
    let parents = git(
        &fixture.remote,
        &["rev-list", "--parents", "-n", "1", &merged],
    );
    assert_eq!(parents, format!("{merged} {other} {head}"));
    let author = git(
        &fixture.remote,
        &["log", "-1", "--format=%an <%ae>%n%B", &merged],
    );
    assert!(
        author.starts_with("Docs <docs@noreply.supertag.invalid>"),
        "{author}"
    );
    assert!(
        author.contains("Co-authored-by: ada <ada@noreply.supertag.invalid>"),
        "{author}"
    );
    assert!(author.contains("SuperTag-Session: work/notes"), "{author}");
    assert_eq!(fixture.remote_ref(&landing.branch), head);

    // Already merged: nothing new is pushed.
    let again = fixture
        .delivery
        .land(&landing, &remote(&landing), &bundle, &cancel)
        .await
        .unwrap();
    assert_eq!(again, Outcome::Landed(merged));
}

#[tokio::test]
async fn a_conflict_is_reported_and_never_resolved() {
    let fixture = Fixture::new();
    let cancel = CancellationToken::new();
    let target = fixture.push_other("drafts", "notes.md", "line one\ntheirs\n");
    let (head, bundle, blob) = fixture.session("conflict", "line one\nours\n");
    let landing = fixture.landing(WorkspaceLandingMode::Merge, &head, blob);
    let outcome = fixture
        .delivery
        .land(&landing, &remote(&landing), &bundle, &cancel)
        .await
        .unwrap();
    assert_eq!(
        outcome,
        Outcome::Conflict {
            target_commit: target.clone(),
            conflicts: vec!["notes.md".into()],
        }
    );
    // The target is untouched; the Session's own branch is still delivered.
    assert_eq!(fixture.remote_ref("drafts"), target);
    assert_eq!(fixture.remote_ref(&landing.branch), head);
}

#[tokio::test]
async fn landing_refuses_refs_outside_the_allowlist_and_a_credential_for_another_remote() {
    let fixture = Fixture::new();
    let cancel = CancellationToken::new();
    let (head, bundle, blob) = fixture.session("refused", "line one\nx\n");
    let mut landing = fixture.landing(WorkspaceLandingMode::Merge, &head, blob.clone());
    landing.target = "supertag/session/sneaky".into();
    assert!(
        fixture
            .delivery
            .land(&landing, &remote(&landing), &bundle, &cancel)
            .await
            .is_err()
    );
    let landing = fixture.landing(WorkspaceLandingMode::Branch, &head, blob);
    let elsewhere = Remote::new("https://example.invalid/other.git", None).unwrap();
    assert!(
        fixture
            .delivery
            .land(&landing, &elsewhere, &bundle, &cancel)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn check_reports_each_step_without_changing_the_remote() {
    let fixture = Fixture::new();
    let cancel = CancellationToken::new();
    let before = git(&fixture.remote, &["for-each-ref"]);
    let check = fixture
        .delivery
        .check(
            &fixture.workspace(Some(workspace_land::Mode::Merge(WorkspaceLandMerge {
                target: "drafts".into(),
            }))),
            &cancel,
        )
        .await
        .unwrap();
    let status = |name: &str| {
        check
            .steps
            .iter()
            .find(|step| step.step == name)
            .map(|step| (step.status(), step.detail.clone()))
            .unwrap()
    };
    assert_eq!(
        status("read").0,
        WorkspaceCheckStatus::Ok,
        "{:?}",
        status("read")
    );
    assert_eq!(
        status("push").0,
        WorkspaceCheckStatus::Ok,
        "{:?}",
        status("push")
    );
    assert_eq!(status("scope").0, WorkspaceCheckStatus::Warning);
    assert_eq!(status("review").0, WorkspaceCheckStatus::NotApplicable);
    assert_eq!(status("ci").0, WorkspaceCheckStatus::Unknown);
    assert_eq!(git(&fixture.remote, &["for-each-ref"]), before);

    let mut missing = fixture.workspace(None);
    missing.remote = "file:///nonexistent/remote.git".into();
    let check = fixture.delivery.check(&missing, &cancel).await.unwrap();
    assert_eq!(check.steps[0].status(), WorkspaceCheckStatus::Failed);
}

/// The Control Plane hands a Worker Host the credential for one operation: an HTTPS token or SSH
/// key as it is, nothing for a remote that needs none, and never a credential helper, which runs
/// only on the Control Plane's machine. A Worker Host has no vault to read one from.
#[tokio::test]
async fn grants_hand_hosts_static_credentials_but_never_a_helper() {
    use supertag_git_delivery::Credential;
    use supertag_protocol::{git_remote::credential_vault_id, v2::WorkspaceCredentialNames};
    let fixture = Fixture::new();
    let named = |name: &str| {
        let mut workspace = fixture.workspace(None);
        workspace.credentials = Some(WorkspaceCredentialNames {
            read: name.into(),
            push: String::new(),
        });
        workspace
    };
    // The same vault directory the fixture's git delivery reads.
    let state = fixture.state.display().to_string();
    let vault = CredentialVault::from_environment(|key| {
        (key == "SUPERTAG_STATE_DIR").then(|| state.clone())
    })
    .unwrap();
    let store = |name: &str, credential: Credential| {
        let id = credential_vault_id(name);
        let vault = &vault;
        async move {
            vault
                .store(&id, &credential.to_vault_value())
                .await
                .unwrap()
        }
    };
    let none = fixture
        .delivery
        .grant(&fixture.workspace(None), Access::Read)
        .await
        .unwrap();
    assert!(none.credential.is_none() && none.expires_at_ms == 0);

    let token = Credential::HttpsToken {
        username: "deploy".into(),
        token: "static-token".into(),
    };
    store("token", token.clone()).await;
    let granted = fixture
        .delivery
        .grant(&named("token"), Access::Read)
        .await
        .unwrap();
    assert!(granted.credential == Some(token) && granted.expires_at_ms == 0);

    store(
        "helper",
        Credential::Helper {
            helper: "store".into(),
        },
    )
    .await;
    let refused = fixture
        .delivery
        .grant(&named("helper"), Access::Read)
        .await
        .err()
        .unwrap();
    assert!(
        format!("{refused:#}").contains("credential helper"),
        "{refused:#}"
    );

    let host_directory = tempfile::tempdir().unwrap();
    let host = GitDelivery::for_host(&host_directory.path().join("git")).unwrap();
    let error = host
        .grant(&named("token"), Access::Read)
        .await
        .err()
        .unwrap();
    assert!(
        format!("{error:#}").contains("kept on the Control Plane"),
        "{error:#}"
    );
}
