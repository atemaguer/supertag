use std::io::IsTerminal;

use anyhow::{Result, ensure};
use serde_json::json;

/// The format `supertag __local-gateway` prints; the desktop app checks it.
const LOCAL_PROTOCOL: &str = "local-gateway.v2";

/// Prints the local Gateway the desktop app offers as Local, with the operator token read from
/// the state directory now, so a token `supertag up` replaced is never stale. Only a pipe
/// receives it: the token is never shown in a terminal. It also says whether SuperTag is set up
/// in the state directory, so the desktop app knows to start stopped services, and this
/// machine's identifier, which tells a client that a Task's files are on its own disk (null when
/// it can't be read or created).
pub fn print_local_gateway() -> Result<()> {
    ensure!(
        // terminal-safe: only checks whether output is a terminal.
        !std::io::stdout().is_terminal(),
        "this command is for the desktop app; it prints the local operator token"
    );
    let directory = supertag_local_state::state_directory(None)?;
    let set_up = supertag_local_state::set_up(&directory);
    let machine_id = supertag_local_state::machine_id().ok();
    let value = match supertag_local_state::gateway(&directory)? {
        Some(local) => json!({
            "protocol": LOCAL_PROTOCOL, "running": true,
            "state_directory": directory, "set_up": set_up, "machine_id": machine_id,
            "url": local.url, "token": local.token,
        }),
        None => json!({
            "protocol": LOCAL_PROTOCOL, "running": false,
            "state_directory": directory, "set_up": set_up, "machine_id": machine_id,
            "message": supertag_local_state::not_running(&directory),
        }),
    };
    crate::terminal::print_json(&value)?;
    Ok(())
}
