fn main() {
    // Compile-time build information.
    built::write_built_file().expect("Failed to write build information");

    // The `built` crate records the rustc version but not the cargo
    // version. Capture it so the platform information (WJ-1279) can
    // report the full toolchain that produced this binary.
    println!("cargo:rustc-env=DEEPWELL_CARGO_VERSION={}", cargo_version());

    // The promotion builder passes the source commit explicitly because
    // Docker build contexts exclude the .git directory, which is where
    // the `built` crate would otherwise read it from (WJ-1279).
    println!(
        "cargo:rustc-env=DEEPWELL_GIT_COMMIT={}",
        std::env::var("WIKIJUMP_GIT_COMMIT").unwrap_or_default(),
    );
    println!("cargo:rerun-if-env-changed=WIKIJUMP_GIT_COMMIT");

    // The pinned FTML commit, for the platform information page.
    println!("cargo:rustc-env=DEEPWELL_FTML_COMMIT={}", ftml_commit());
    println!("cargo:rerun-if-changed=Cargo.lock");

    // Trigger recompilation when a new migration is added.
    println!("cargo:rerun-if-changed=migrations");
}

fn ftml_commit() -> String {
    let lockfile = std::fs::read_to_string("Cargo.lock").expect("Cargo.lock is readable");
    lockfile
        .lines()
        .skip_while(|line| *line != "name = \"ftml\"")
        .find_map(|line| line.strip_prefix("source = \"git+")?.strip_suffix('"'))
        .and_then(|source| source.split_once('#'))
        .map(|(_, commit)| commit.to_owned())
        .expect("Cargo.lock pins FTML to a git commit")
}

fn cargo_version() -> String {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());

    match std::process::Command::new(cargo).arg("--version").output() {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        }
        _ => "unknown".to_owned(),
    }
}
