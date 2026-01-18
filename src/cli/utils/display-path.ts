import path from 'node:path';

export const toDisplayPath = (targetPath: string): string => {
  const absolutePath = path.resolve(targetPath);
  const relativePath = path.relative(process.cwd(), absolutePath);
  return relativePath === '' ? '.' : relativePath;
};
