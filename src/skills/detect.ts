import { CONFIG } from '../config.js';
import type { RepoClient } from '../types.js';

export async function hasSkills(repo: RepoClient): Promise<boolean> {
  try {
    await repo.readRaw(`${CONFIG.skills.dir}/skill.md`);
    return true;
  } catch {
    return false;
  }
}

export async function readSkillMd(repo: RepoClient): Promise<string | null> {
  try {
    return await repo.readRaw(`${CONFIG.skills.dir}/skill.md`);
  } catch {
    return null;
  }
}
