import path from 'node:path';

export const toDisplayPath = (targetPath: string): string => {
  return path.resolve(targetPath);
};
