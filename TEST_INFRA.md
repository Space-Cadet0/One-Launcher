# E2E Test Infra: One Launcher

## Test Philosophy
- Opaque-box, requirement-driven testing derived from `ORIGINAL_REQUEST.md` (Requirements R1–R4) and `PROJECT.md` (Features 1–24).
- Zero reliance on internal module implementation details.
- Methodology: Category-Partition Testing, Boundary Value Analysis (BVA), Pairwise Combinatorial Testing, and Real-World Application Workload Simulation.
- Hardware-accurate whole-display verification: physical display inspection (`screencapture -x`) verifying 3024×1964 Retina geometry, pitch-black `#000000` pillarboxes, and Menu Bar / Dock auto-hide (Requirement R3).

## Feature Inventory & Tier Coverage Targets
All 24 features from `PROJECT.md § Feature Inventory` are tracked with explicit 4-tier coverage goals:

| # | Feature | Source (Milestone) | Tier 1 (Coverage) | Tier 2 (Boundary) | Tier 3 (Pairwise) | Tier 4 (Scenarios) |
|---|---------|-------------------|:---:|:---:|:---:|:---:|
| 1 | C11 Zero-Drift Coordinate Math | M1 (Scaler) | 5 | 5 | ✓ | ✓ |
| 2 | Wine D3DKMTEscape Unclamp | M1 (Scaler) | 5 | 5 | ✓ | ✓ |
| 3 | OpenGL Two-Pass Sharp Bilinear | M1 (Scaler) | 5 | 5 | ✓ | ✓ |
| 4 | Scaler Mode Table Synthesis | M1 (Scaler) | 5 | 5 | ✓ | ✓ |
| 5 | Modal Dialog Promotion | M1 (Scaler) | 5 | 5 | ✓ | ✓ |
| 6 | Scaler Multi-Hop Process Injection | M1 (Scaler) | 5 | 5 | ✓ | ✓ |
| 7 | Whole-Display Scaler Verification Tool | M1 (Scaler) | 5 | 5 | ✓ | ✓ |
| 8 | Xbox LiveSDK Desktop OAuth 2.0 | M2 (Storefronts) | 5 | 5 | ✓ | ✓ |
| 9 | Xbox GDK Bridge Struct Alignment | M2 (Storefronts) | 5 | 5 | ✓ | ✓ |
| 10 | Encrypted Token Vault | M2 (Storefronts) | 5 | 5 | ✓ | ✓ |
| 11 | Steam Two-Stage Cold-Start Sync | M2 (Storefronts) | 5 | 5 | ✓ | ✓ |
| 12 | GOG V2 Streaming Extractor | M2 (Storefronts) | 5 | 5 | ✓ | ✓ |
| 13 | Epic Third-Party Partner Handoff | M2 (Storefronts) | 5 | 5 | ✓ | ✓ |
| 14 | Universal Portability & Zero-PII | M2 (Storefronts) | 5 | 5 | ✓ | ✓ |
| 15 | Process Supervisor & Job Objects | M3 (Supervisor) | 5 | 5 | ✓ | ✓ |
| 16 | Security & Path Sanitization | M3 (Supervisor) | 5 | 5 | ✓ | ✓ |
| 17 | Offline SQLite WAL & Media Cache | M3 (Supervisor) | 5 | 5 | ✓ | ✓ |
| 18 | Dual-OS Wine & Bottle Manager | M3 (Supervisor) | 5 | 5 | ✓ | ✓ |
| 19 | React 19 UI Efficiency & Transitions | M4 (Frontend) | 5 | 5 | ✓ | ✓ |
| 20 | Robust Error Boundaries | M4 (Frontend) | 5 | 5 | ✓ | ✓ |
| 21 | High-Speed Scroll Image Shielding | M4 (Frontend) | 5 | 5 | ✓ | ✓ |
| 22 | Strict 3-Tier DAG & Zero-Any AST | M4 (Frontend) | 5 | 5 | ✓ | ✓ |
| 23 | E2E Test Suite Execution (Tiers 1–4) | M5 (Final) | 5 | 5 | ✓ | ✓ |
| 24 | Adversarial Coverage Hardening (Tier 5) | M5 (Final) | 5 | 5 | ✓ | ✓ |
| **Total** | **24 Features** | | **≥120** | **≥120** | **≥36** | **≥16** |

## Test Architecture

### 1. Test Directory Layout
```
tests/e2e_fullscreen/
├── run_all.cjs                              # Master runner executing all tiers (zero npm deps)
├── native_oracle.cjs                        # Clang-compiled C11 oracle bridge for math ground truth
├── tier1_features/                          # Tier 1: Feature Coverage (happy path, >=5 tests/feature)
│   ├── f1_backdrop_shields.test.cjs
│   ├── f2_hidpi_policy.test.cjs
│   ├── f3_mode_table.test.cjs
│   ├── f4_symmetric_panel.test.cjs
│   ├── f5_runtime_virtualization.test.cjs
│   ├── f6_retina_windowed.test.cjs
│   ├── f7_jk2_white_borders.test.cjs
│   ├── f8_jk2_esc_menu.test.cjs
│   ├── f9_jk2_cmd_tab.test.cjs
│   ├── f10_jk2_mouse_look.test.cjs
│   ├── f11_q3_centered_placement.test.cjs
│   ├── f12_q3_mouse_cursor.test.cjs
│   ├── f13_universal_portability.test.cjs
│   ├── f14_live_fullscreen.test.cjs         # Upgraded with R3 whole-display verification
│   ├── f15_code_review_audit.test.cjs
│   ├── f16_universal_launcher_chaining.test.cjs
│   ├── f17_storefronts_auth_vault.test.cjs  # Features 8, 9, 10
│   ├── f18_storefronts_sync_ingest.test.cjs # Features 11, 12, 13
│   ├── f19_supervisor_security_db.test.cjs  # Features 15, 16, 17, 18
│   └── f20_frontend_modern_web.test.cjs     # Features 19, 20, 21, 22
├── tier2_boundaries/                        # Tier 2: Boundary & Corner Cases (>=5 tests/feature)
│   ├── f1_backdrop_boundary.test.cjs
│   ├── f2_hidpi_boundary.test.cjs
│   ├── f3_mode_table_boundary.test.cjs
│   ├── f4_symmetric_boundary.test.cjs
│   ├── f5_virtualization_boundary.test.cjs
│   ├── f6_windowed_boundary.test.cjs
│   ├── f7_white_borders_boundary.test.cjs
│   ├── f8_esc_menu_boundary.test.cjs
│   ├── f9_cmd_tab_boundary.test.cjs
│   ├── f10_mouse_look_boundary.test.cjs
│   ├── f11_q3_placement_boundary.test.cjs
│   ├── f12_q3_mouse_boundary.test.cjs
│   ├── f13_portability_boundary.test.cjs
│   ├── f14_live_boundary.test.cjs
│   ├── f15_audit_boundary.test.cjs
│   ├── f16_storefronts_boundary.test.cjs    # Features 8-13 boundaries
│   ├── f17_supervisor_boundary.test.cjs     # Features 15-18 boundaries
│   └── f18_frontend_boundary.test.cjs       # Features 19-22 boundaries
├── tier3_combinations/                      # Tier 3: Pairwise Interactions
│   └── pairwise_interactions.test.cjs       # 36 pairwise interaction test cases
└── tier4_scenarios/                         # Tier 4: Real-World Scenarios
    └── application_scenarios.test.cjs       # 16 complete end-user application workflows

scripts/
└── verify-display-output.cjs                # Turnkey whole-display screencapture inspection tool
```

### 2. Test Runner Semantics & Commands
- **Full E2E Suite Execution**:
  ```bash
  node tests/e2e_fullscreen/run_all.cjs
  ```
  Pass semantics: All registered tests across Tiers 1-4 execute and pass with exit code 0.
- **Verification Mode (Structure & Integrity)**:
  ```bash
  node tests/e2e_fullscreen/run_all.cjs --verify
  ```
  Validates that all test files load correctly and counts tests per tier.
- **Tier-Specific Filtering**:
  ```bash
  node tests/e2e_fullscreen/run_all.cjs --tier=1
  node tests/e2e_fullscreen/run_all.cjs --tier=2
  node tests/e2e_fullscreen/run_all.cjs --tier=3
  node tests/e2e_fullscreen/run_all.cjs --tier=4
  ```
- **Feature-Specific Filtering**:
  ```bash
  node tests/e2e_fullscreen/run_all.cjs --feature=F14
  ```
- **Whole-Display Scaler Verification Tool**:
  ```bash
  node scripts/verify-display-output.cjs --synthetic
  node scripts/verify-display-output.cjs --capture
  ```

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Cold Boot with Fresh Install & Zero Accounts | F10, F14, F16, F17, F22 | High |
| 2 | Multi-Storefront Concurrent Ingestion | F8, F10, F11, F12, F13, F17, F19 | High |
| 3 | High-Velocity Virtual Library Browsing & Scroll Shielding | F19, F21 | Medium |
| 4 | Star Wars Jedi Knight II DirectDraw Cold Launch on Retina Display | F1, F2, F4, F7, F15, F18 | High |
| 5 | In-Game ESC Menu & 360° Zero-Drift Mouse Look Torture | F1, F2, F5 | High |
| 6 | Cmd+Tab Desktop / Game Focus Cycles | F1, F2, F5, F15 | Medium |
| 7 | Modal Dialog Foreground Promotion | F5, F15 | Medium |
| 8 | Multi-Hop Chained Launcher Execution | F6, F15, F18 | High |
| 9 | Quake III Arena In-Game Video Mode Switch & FBO Recreation | F1, F3, F4, F7 | High |
| 10 | Epic Games EA App Partner Provisioning & Delegation | F13, F15, F18 | High |
| 11 | Steam Two-Stage Post-Gameplay Cloud Save Upload Barrier | F11, F15 | Medium |
| 12 | GOG V2 Streaming Multi-Part Download & Interruption Resume | F12, F16, F17 | High |
| 13 | Network Outage Offline Cache Fallback & Media Streaming | F16, F17, F20 | Medium |
| 14 | Corrupted Metadata Recovery via Modal Error Boundaries | F19, F20, F22 | Medium |
| 15 | Physical Whole-Display Retina Output Verification (Requirement R3) | F7 (R3) | High |
| 16 | Clean Supervisor Teardown & Zero Zombie Child Processes | F15, F16, F18 | Medium |

## Coverage Thresholds
- **Tier 1 (Feature Coverage)**: ≥5 tests per feature across all 24 features (≥120 tests).
- **Tier 2 (Boundary & Corner Cases)**: ≥5 tests per feature across all 24 features (≥120 tests).
- **Tier 3 (Cross-Feature Combinations)**: ≥36 pairwise interaction test cases.
- **Tier 4 (Real-World Scenarios)**: ≥16 realistic end-to-end application lifecycle scenarios.
- **Total Minimum Target**: ≥292 test cases.
- **Pass Criteria**: 100% exit code 0 across all tiers.
