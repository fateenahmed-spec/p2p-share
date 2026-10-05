const FILE_ID = /^[a-f0-9]{64}$/;

export function fileEntryNames(fileId) {
  if (typeof fileId !== 'string' || !FILE_ID.test(fileId)) throw new TypeError('Invalid file ID for OPFS entry name');
  return { data: `data-${fileId}.bin`, progress: `progress-${fileId}.bin` };
}
