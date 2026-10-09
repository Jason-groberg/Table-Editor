import { readFile } from './files.js';
self.onmessage = async event => {
  try { self.postMessage({sheets:await readFile(event.data.name,event.data.buffer)}); }
  catch(error) { self.postMessage({error:error.message || 'Unable to read this file.'}); }
};
