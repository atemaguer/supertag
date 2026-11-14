fn main() -> Result<(), Box<dyn std::error::Error>> {
    let files = [
        "../../proto/supertag/runtime/v2/runtime.proto",
        "../../proto/supertag/runtime/v2/policy.proto",
        "../../proto/supertag/runtime/v2/github_workspaces.proto",
        "../../proto/supertag/runtime/v2/github_publications.proto",
        "../../proto/supertag/runtime/v2/mcp.proto",
        "../../proto/supertag/runtime/v2/artifact.proto",
        "../../proto/supertag/runtime/v2/workspace_volume.proto",
        "../../proto/supertag/runtime/v2/negotiation.proto",
        "../../proto/supertag/runtime/v2/access.proto",
        "../../proto/supertag/runtime/v2/placement.proto",
        "../../proto/supertag/runtime/v2/reply_progress.proto",
        "../../proto/supertag/runtime/v2/spend.proto",
        "../../proto/supertag/runtime/v2/metrics.proto",
        "../../proto/supertag/runtime/v2/changed_paths.proto",
        "../../proto/supertag/runtime/v2/effects.proto",
        "../../proto/supertag/runtime/v2/operator_notifications.proto",
        "../../proto/supertag/runtime/v2/objective_overview.proto",
    ];
    for file in files {
        println!("cargo:rerun-if-changed={file}");
    }
    let mut prost = tonic_prost_build::Config::new();
    prost.protoc_executable(protoc_bin_vendored::protoc_bin_path()?);
    let descriptors =
        std::path::PathBuf::from(std::env::var("OUT_DIR")?).join("supertag_descriptors.bin");
    tonic_prost_build::configure()
        .file_descriptor_set_path(descriptors)
        .compile_with_config(prost, &files, &["../../proto"])?;
    Ok(())
}
