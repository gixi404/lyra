fn main() {
    // Silencia la advertencia de deprecación de STATIC_VCRUNTIME inyectada por @tauri-apps/cli
    std::env::remove_var("STATIC_VCRUNTIME");

    let now_str = chrono::Utc::now().to_rfc3339();
    println!("cargo:rustc-env=LYRA_BUILD_TIMESTAMP={now_str}");

    tauri_build::try_build(
        tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new().static_vc_runtime(true),
        ),
    )
    .expect("failed to run tauri-build");
}
