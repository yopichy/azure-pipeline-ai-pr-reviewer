import { SimpleGitOptions, SimpleGit, simpleGit } from 'simple-git';
import * as tl from "azure-pipelines-task-lib/task";
import binaryExtensions from 'binary-extensions';
import { getFileExtension } from './utils';

const gitOptions: Partial<SimpleGitOptions> = {
  baseDir: `${tl.getVariable('System.DefaultWorkingDirectory')}`,
  binary: 'git'
};

export const git: SimpleGit = simpleGit(gitOptions);

export async function getChangedFiles(targetBranch: string) {
  await git.addConfig('core.pager', 'cat');
  await git.addConfig('core.quotepath', 'false');
  await git.fetch();

  const diffs = await git.diff([targetBranch, '--name-only', '--diff-filter=AM']);
  const files = diffs.split('\n').filter(line => line.trim().length > 0);
  const nonBinaryFiles = files.filter(file => !binaryExtensions.includes(getFileExtension(file)));

  console.log(`Changed Files (excluding binary files) : \n ${nonBinaryFiles.join('\n')}`);

  return nonBinaryFiles;
}

export async function getCommitMessages(targetBranch: string, maxCount: number = 20): Promise<string> {
  await git.fetch();

  const logOutput = await git.raw([
    "log",
    `${targetBranch}..HEAD`,
    `--max-count=${maxCount}`,
    "--pretty=format:%h %s",
  ]);

  const commitMessages = logOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");

  if (commitMessages) {
    console.log(`Commit messages used as context:\n${commitMessages}`);
  } else {
    console.log("No commit messages found in PR range for additional context.");
  }

  return commitMessages;
}