const path = require('node:path');
const { cleanupJobs } = require('../job-cleanup');

const jobsDir = path.resolve(__dirname, '..', 'jobs');
const dryRun = process.argv.includes('--execute') ? false : true;
const retentionDays = Number(process.env.HCI_JOB_RETENTION_DAYS || 30);
const orphanRetentionDays = Number(process.env.HCI_ORPHAN_JOB_RETENTION_DAYS || 7);

const result = cleanupJobs({
  jobsDir,
  retentionDays,
  orphanRetentionDays,
  removeDebugArtifacts: true,
  dryRun,
});

console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'execute', ...result }, null, 2));
