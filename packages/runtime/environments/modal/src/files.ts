/** Descriptor-relative file operations run inside the sandbox; no path-check/use gap. */
export const FILE_HELPER = `import os, sys, stat
operation, path, limit, mode = sys.argv[1:]
limit, mode = int(limit), int(mode)
parts = [p for p in path.split("/") if p]
if not path.startswith("/") or any(p in (".", "..") for p in parts): raise ValueError("invalid path")
fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
try:
 parents = parts if operation == "mkdir" else parts[:-1]
 for part in parents:
  if operation == "mkdir":
   try: os.mkdir(part, 0o700, dir_fd=fd)
   except FileExistsError: pass
  next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
  os.close(fd)
  fd = next_fd
 if operation == "write":
  out = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=fd)
  with os.fdopen(out, "wb") as target:
   while True:
    data = sys.stdin.buffer.read(65536)
    if not data: break
    target.write(data)
 elif operation == "read":
  out = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
  try:
   if not stat.S_ISREG(os.fstat(out).st_mode): raise ValueError("not regular")
   data = bytearray()
   while len(data) <= limit:
    chunk = os.read(out, min(65536, limit + 1 - len(data)))
    if not chunk: break
    data.extend(chunk)
   if len(data) > limit: raise ValueError("too large")
   sys.stdout.buffer.write(data)
  finally: os.close(out)
 elif operation == "readonly":
  def protect(parent, name):
   child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
   try:
    info = os.fstat(child)
    if stat.S_ISDIR(info.st_mode):
     for entry in os.listdir(child): protect(child, entry)
    elif not stat.S_ISREG(info.st_mode): raise ValueError("not regular")
    os.fchmod(child, stat.S_IMODE(info.st_mode) & ~0o222)
   finally: os.close(child)
  protect(fd, parts[-1])
 elif operation != "mkdir": raise ValueError("unknown operation")
finally: os.close(fd)
`;
