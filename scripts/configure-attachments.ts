import { loadConfig } from '@chat/config';
import { AttachmentStorage } from '@chat/domain';
const storage = new AttachmentStorage(loadConfig());
try { await storage.configureCors(); console.log('Configured quarantine PUT CORS for WEB_ORIGIN. Both buckets remain private.'); }
finally { storage.close(); }
