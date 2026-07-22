// Throwaway read-only benchmark: times each stage of the state build
// against the real vault. Run with:
//   cargo run --release --example bench_state
use std::time::Instant;

#[tokio::main]
async fn main() {
    let home = dirs::home_dir().expect("home");
    let app_home = home.join(".agent-skill-manager");
    let config_path = app_home.join("config.json");
    let config = skillworks_desktop::backend::config::Config::load(&config_path)
        .await
        .expect("config");
    let raw_vault = config.vault_root.clone().expect("vault_root in config");
    let vault_root = if let Ok(stripped) = raw_vault.strip_prefix("~") {
        home.join(stripped)
    } else {
        raw_vault
    };
    println!("vault: {}", vault_root.display());

    let t0 = Instant::now();
    let roots = skillworks_desktop::backend::skills::find_skill_roots(&vault_root)
        .await
        .expect("roots");
    println!("find_skill_roots: {} roots in {:?}", roots.len(), t0.elapsed());

    let cache_path = app_home.join("skills-cache.json");
    let t1 = Instant::now();
    let skills =
        skillworks_desktop::backend::skills::discover_skills(&vault_root, Some(&cache_path))
            .await
            .expect("skills");
    println!("discover_skills: {} skills in {:?}", skills.len(), t1.elapsed());

    let t2 = Instant::now();
    let state = skillworks_desktop::backend::commands::build_state(None, None)
        .await
        .expect("state");
    println!(
        "build_state: {} skills, {} targets in {:?}",
        state.skills.len(),
        state.targets.len(),
        t2.elapsed()
    );

    let t3 = Instant::now();
    let json = serde_json::to_string(&state).expect("json");
    println!(
        "serialize state: {:.1} MB in {:?}",
        json.len() as f64 / 1_048_576.0,
        t3.elapsed()
    );
}
