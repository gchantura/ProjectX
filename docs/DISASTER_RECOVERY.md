# Disaster Recovery

## Service objectives

The portable recovery tier targets a 24-hour recovery point objective and a four-hour recovery time objective. The daily backup CronJob provides the portable RPO; enable managed PostgreSQL point-in-time recovery for a tighter database RPO. The monthly isolated restore drill proves that the latest encrypted artifact can be decrypted, checksum-verified, parsed by `pg_restore`, restored, and queried.

These objectives are not proven in a target environment until three consecutive scheduled backups and one scheduled restore drill succeed under production monitoring. Alert on failed or missing CronJobs. Record drill duration, backup size, restored migration version, operator, and incident link in the change system.

## Storage requirements

`kcevagent-backups` must use a storage class with encrypted off-site replication or scheduled volume snapshots in a separate failure domain and account. The PVC alone is not a disaster-recovery boundary. Restrict access to the backup and recovery service accounts. Store `kcevagent-recovery/encryption-password` in an external secret manager, rotate it under a dual-control change, and retain the old key until every artifact encrypted with it expires.

The workspace PVC contains checked-out source and generated artifacts. Protect it with the platform snapshot controller or reconstruct workspaces from their authoritative Git remotes. Never treat the workspace volume as the authoritative database backup.

## Recovery procedure

1. Declare the incident, freeze writes at ingress, and preserve application, database, and audit logs.
2. Select the newest backup whose `.sha256` sidecar validates. Record its timestamp and checksum.
3. Provision an isolated PostgreSQL instance with no production network route.
4. Run `restore-verify.sh` with `ALLOW_DESTRUCTIVE_RESTORE=verify-isolated-database`, the isolated `RESTORE_DATABASE_URL`, selected `BACKUP_FILE`, and the recovery key.
5. Verify migration history, tenant count, audit-chain integrity, representative run exports, identity state, and project readiness.
6. Restore the complete `KCEV_SECRETS_ENCRYPTION_KEYS` keyring, active key ID, and any still-required legacy v1 key from encrypted escrow before testing tenant SSO. Run `npm run secrets:rotate -- --dry-run`; every key ID reported under `byKey` must exist in the restored keyring. If a required key is unavailable, its OIDC credentials are intentionally unrecoverable and every affected organization must rotate its IdP credential through Administration.
7. Promote through the database provider's controlled recovery process. Rotate database credentials before reopening ingress.
8. Run `/api/health/ready`, compare SLOs, execute a read-only canary run, and obtain incident-commander approval before restoring writes.

Never restore directly over the production database. Never bypass checksum or decryption failures. A failed monthly drill is a critical operational incident because recoverability is then unproven.

After a key-rotation recovery, do not retire restored old keys merely because the application starts. Execute the re-encryption command, require zero pending and failed records on a second dry run, confirm diagnostics reports retirement readiness, and archive the new keyring before removing old key material.
