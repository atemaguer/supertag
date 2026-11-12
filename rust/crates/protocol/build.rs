fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto = "../../proto/supertag/runtime/v2/runtime.proto";
    let policy = "../../proto/supertag/runtime/v2/policy.proto";
    println!("cargo:rerun-if-changed={proto}");
    println!("cargo:rerun-if-changed={policy}");
    let mut prost = tonic_prost_build::Config::new();
    prost.protoc_executable(protoc_bin_vendored::protoc_bin_path()?);
    tonic_prost_build::configure().compile_with_config(
        prost,
        &[proto, policy],
        &["../../proto"],
    )?;
    Ok(())
}
