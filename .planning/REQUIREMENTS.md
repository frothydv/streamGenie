# Requirements: Stream Genie

**Defined:** 2026-05-13
**Core Value:** Any viewer can hover over anything on a Twitch stream and see an explanation — no streamer setup required.

## v1.0 Beta Requirements

Requirements for public beta. All derived from CLAUDE.md "What remains before a public beta."

### Profile Curation

- [ ] **CUR-01**: Contributor can delete a trigger from within the extension editor
- [ ] **CUR-02**: Contributor can overwrite a trigger with a new reference image while preserving existing metadata (payload, offset, rotation schema)
- [ ] **CUR-03**: Popup shows a profile grid/review mode so a contributor can scan all triggers as thumbnails
- [ ] **CUR-04**: Near-duplicate detection surfaces triggers whose perceptual hashes are within a configurable distance threshold

### Viewer Onboarding

- [ ] **ONB-01**: When no profile is loaded for the current stream, the popup displays a "no profile found" state with an explanation of what the extension does
- [ ] **ONB-02**: On first install, a one-time banner appears explaining the extension and linking to setup/contribution docs

### Error States

- [x] **ERR-01**: When the profile CDN is unreachable, the debug panel shows a visible error indicator (not silent failure)
- [x] **ERR-02**: When profile JSON fails to parse, the debug panel shows a warning with the parse error
- [x] **ERR-03**: When profile JSON fails schema validation, the debug panel shows which fields are invalid

### Privacy & Permissions

- [ ] **PRIV-01**: The first-run experience (ONB-02 banner) includes a clear statement that pixel processing is local and no data leaves the device
- [ ] **PRIV-02**: README and store-listing text document every permission in manifest.json with a plain-language explanation of why it's needed

## Post-Beta (v1.1+)

Acknowledged, not in current roadmap.

- Auto-profile selection in popup (pick top verified profile automatically)
- Creator/streamer-specific profile config (`creators/twitch/` lookup)
- Profile upvotes and community sorting
- Owner review UI and viewer report button
- YouTube support, Firefox support
- Sub-720p matching improvements
- Telemetry (requires backend + privacy consideration)

## Out of Scope (v1.0)

| Feature | Reason |
|---------|--------|
| YouTube support | Post-beta, same code path but different platform module |
| Firefox support | Post-beta |
| Streamer-declared profile bundles | CLAUDE.md explicitly defers this |
| Roles/permissions UI | CODEOWNERS convention sufficient until community scale forces it |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| CUR-01 | Phase 10 | Pending |
| CUR-02 | Phase 10 | Pending |
| CUR-03 | Phase 10 | Pending |
| CUR-04 | Phase 10 | Pending |
| ONB-01 | Phase 11 | Pending |
| ONB-02 | Phase 11 | Pending |
| ERR-01 | Phase 12 | Complete |
| ERR-02 | Phase 12 | Complete |
| ERR-03 | Phase 12 | Complete |
| PRIV-01 | Phase 13 | Pending |
| PRIV-02 | Phase 13 | Pending |

**Coverage:**
- v1.0 requirements: 11 total
- Mapped to phases: 11
- Unmapped: 0 ✓

---
*Requirements defined: 2026-05-13*
*Last updated: 2026-05-13 — bootstrapped from CLAUDE.md pre-beta section*
