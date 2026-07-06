// ==========================================
// RENDER WORKER (run as its own process: `node worker.js`)
// ==========================================
// This is intentionally a SEPARATE process from server.js. Node's Express
// process stays free to serve furniture/geometry/API traffic while this
// process (or N copies of it, scaled independently) burns CPU/GPU time on
// Blender renders. Run more than one of these side by side to increase
// render concurrency without touching the API server at all.
require('dotenv').config();
const { Worker } = require('bullmq');
const fs = require('fs');
const path = require('path');
const { connection, RENDER_QUEUE_NAME } = require('./queue');

// How many renders this single worker process will run at once.
// Blender renders are CPU/GPU heavy — keep this low (1-2) unless you know
// your hardware can handle more concurrent headless instances.
const CONCURRENCY = parseInt(process.env.RENDER_CONCURRENCY || '1', 10);

const worker = new Worker(
  RENDER_QUEUE_NAME,
  async (job) => {
    const { projectJobId, jobDir, angle, lighting } = job.data;
    console.log(`\n[Worker] Job ${job.id} started | project=${projectJobId} | angle=${angle} | lighting=${lighting}`);

    // ------------------------------------------------------------------
    // MOCK PIPELINE — replace this block with the real Blender call.
    // ------------------------------------------------------------------
    // This fakes a 10-second render by sleeping in 10 x 1s steps and
    // reporting progress after each one, so /api/render/:jobId/status
    // and the frontend polling logic can be built/tested right now
    // without waiting on the real Blender integration.
    const totalSteps = 10;
    for (let step = 1; step <= totalSteps; step++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const pct = Math.round((step / totalSteps) * 100);
      await job.updateProgress(pct);
      console.log(`[Worker] Job ${job.id} progress: ${pct}%`);
    }

    const mockResult = {
      success: true,
      mock: true,
      type: angle === '360' ? '360' : 'image',
      // No real file was produced — this is a placeholder so the frontend
      // response shape matches what the real pipeline will eventually return.
      url: null,
      projectJobId,
      message: 'Mock render complete (no Blender process was actually run).',
    };

    // ------------------------------------------------------------------
    // TODO (next step): swap the mock block above for the real pipeline,
    // reusing the exact logic that used to live inline in POST /api/render:
    //
    //   const { exec } = require('child_process');
    //   const blenderScriptPath = path.join(__dirname, 'blender_render.py');
    //   const inputIfcPath = path.join(jobDir, 'input.ifc');
    //   const projectStatePath = path.join(jobDir, 'project_state.json');
    //   const resultImgPath = path.join(jobDir, 'result.png');
    //   const blenderCmd = `blender --background --python "${blenderScriptPath}" -- ` +
    //     `--ifc "${inputIfcPath}" --state "${projectStatePath}" --output "${resultImgPath}" ` +
    //     `--job-dir "${jobDir}" --angle "${angle}"`;
    //
    //   await new Promise((resolve, reject) => {
    //     exec(blenderCmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
    //       if (err) return reject(err);
    //       // parse RENDER_RESULT_JSON: line from stdout as before, then
    //       // write pano_render.html for 360 angle, then resolve(finalResult)
    //       resolve(finalResult);
    //     });
    //   });
    //
    // Report progress at meaningful checkpoints (e.g. 10% after IFC parse,
    // 50% after material bake, 90% after Blender render call returns)
    // instead of the fake per-second ticks above.
    // ------------------------------------------------------------------

    return mockResult;
  },
  {
    connection,
    concurrency: CONCURRENCY,
  }
);

worker.on('completed', (job, result) => {
  console.log(`[Worker] Job ${job.id} completed:`, result);
});

worker.on('failed', (job, err) => {
  console.error(`[Worker] Job ${job?.id ?? '?'} failed:`, err.message);
});

worker.on('error', (err) => {
  // Errors on the worker itself (e.g. Redis connection drop), not job failures.
  console.error('[Worker] Worker-level error:', err.message);
});

console.log(`🎨 Render worker started (concurrency=${CONCURRENCY}), waiting for jobs on queue "${RENDER_QUEUE_NAME}"...`);
