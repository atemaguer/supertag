fn main() -> Result<(), Box<dyn std::error::Error>> {
    let files = [
        "../../proto/supertag/runtime/v2/runtime.proto",
        "../../proto/supertag/runtime/v2/policy.proto",
        "../../proto/supertag/runtime/v2/github_workspaces.proto",
        "../../proto/supertag/runtime/v2/mcp.proto",
        "../../proto/supertag/runtime/v2/artifact.proto",
    ];
    for file in files {
        println!("cargo:rerun-if-changed={file}");
    }
    let mut prost = tonic_prost_build::Config::new();
    prost.protoc_executable(protoc_bin_vendored::protoc_bin_path()?);
    tonic_prost_build::configure().compile_with_config(prost, &files, &["../../proto"])?;
    Ok(())
}
