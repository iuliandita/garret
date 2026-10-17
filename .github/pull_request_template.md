## Summary

<!-- What does this PR do, and why? -->

-

## Documentation and compatibility

<!-- Name the guides changed, or explain why the change has no documentation impact. For format, schema, or recovery changes, describe compatibility, backup, upgrade, and rollback consequences. -->

-

## Test plan

- [ ] `sh scripts/check-docs --base origin/develop` passes; affected domains have current documentation or a specific no-impact assessment
- [ ] Format/migration changes include compatibility, backup, upgrade, and rollback instructions and state what was actually exercised
- [ ] Changed screenshots record the application version, source, platform, and image hash
- [ ] `bunx tsc --noEmit -p app/tsconfig.json` passes
- [ ] `bun test ./app/ui` and `bun test ./app/harness` pass
- [ ] Host tests pass (if `app/shell-tauri` changed)
- [ ] Checked in the running app (if the interface changed)

Validation performed and platform limits:

<!-- List the checks actually run. State any native platform or running-app checks not performed; retain the documented host-test exceptions. -->

-

## Notes

<!-- Anything reviewers should look at closely, follow-ups, known limits. -->
