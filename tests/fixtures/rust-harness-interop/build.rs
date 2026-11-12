fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=harness.proto");
    tonic_prost_build::configure().compile_protos(&["harness.proto"], &["."])?;
    Ok(())
}
