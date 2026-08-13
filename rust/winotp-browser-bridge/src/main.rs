use std::io;

use winotp_browser_bridge::host;
use winotp_browser_bridge::ipc::LocalIpcTransport;

fn main() {
    let Ok(transport) = LocalIpcTransport::discover() else {
        return;
    };
    let stdin = io::stdin();
    let stdout = io::stdout();
    let _ = host::run(&mut stdin.lock(), &mut stdout.lock(), &transport);
}
