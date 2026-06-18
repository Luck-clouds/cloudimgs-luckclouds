const { syncFileSystem } = require('../services/syncService');

(async () => {
  try {
    const result = await syncFileSystem({ fullRebuild: false });
    console.log('[index:sync] completed:', JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (error) {
    console.error('[index:sync] failed:', error);
    process.exit(1);
  }
})();
