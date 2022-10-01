
import { dirname } from 'path';
import { simpleGit, SimpleGitOptions, SimpleGit } from 'simple-git';

export interface GitLineInfo {
    /** Author email */
    email: string;
    /** Line index (starting 0) */
    lineIndex: number;
    /** The line content, trimmed */
    lineContent: string;
    /** The commit timestamp */
    lineTimestamp: Date;
}

export async function getGitCurrentHead(filePath: string): Promise<string> {
    try {

        const options: Partial<SimpleGitOptions> = {
            baseDir: dirname(filePath),
            binary: 'git',
            maxConcurrentProcesses: 6,
            trimmed: false,
        };

        const git: SimpleGit = simpleGit(options);

        const head = await git.raw('rev-parse', '--short', 'HEAD');
     
        return head;

    } catch (e: any) {
        console.error(`Could not run git rev-parse: ${e.message}`);
        return '';
    }
}

export async function getFileGitInfo(filePath: string): Promise<GitLineInfo[]> {
    let blameOutput: string = '';
    try {

        const options: Partial<SimpleGitOptions> = {
            baseDir: dirname(filePath),
            binary: 'git',
            maxConcurrentProcesses: 6,
            trimmed: false,
        };

        const git: SimpleGit = simpleGit(options);

        blameOutput = await git.raw('blame', '-e', '-t', filePath);

    } catch (e: any) {
        console.error(`Could not run git blame: ${e.message}`);
        return [];
    }

    try {

        const blameLines = blameOutput.split('\n');

        const gitLineInfo: GitLineInfo[] = [];
        for (const blameLine of blameLines) {

            try {
                // Split by first < and then by first >
                const lineRawParts = blameLine?.split(/\<(.*)/s)?.[1]?.split?.(/\>(.*)/s);
                // Take the email part
                const email = lineRawParts?.[0];
                // Take the rest of the line
                const lineRaw1 = lineRawParts?.[1];
                // Split by first ")" aka where the meta ends the the line content stats
                const lineRaw1Parts = lineRaw1?.split(/\)(.*)/s);
                // Take the line meta part
                const lineMeta = lineRaw1Parts?.[0];
                // Take the line content part, trimmed 
                const lineContent = lineRaw1Parts?.[1]?.trim();
                // Split meta by spaces
                const lineMetaParts = lineMeta?.trim().split(' ');
                // The first id the commit timestamp, parse it to date
                const lineTimestamp = new Date(parseInt(lineMetaParts?.[0] || '0') * 1000);
                // The last is the line index, parse it, and sub 1 to align it to base index 0
                const lineIndex = parseInt(lineMetaParts?.[lineMetaParts?.length - 1] || '0') - 1;
                // Push the line info to the collection
                gitLineInfo.push({
                    email,
                    lineIndex,
                    lineContent,
                    lineTimestamp
                });
            } catch (error: any) {
                console.warn(`Failed to parse blame line "${blameLine}": ${error.message}`);
            }
        }

        return gitLineInfo;

    } catch (error: any) {
        console.error(`Failed to parse blame lines: ${error.message}`);
        return [];
    }
}