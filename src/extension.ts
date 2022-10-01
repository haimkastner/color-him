import * as vscode from 'vscode';
import debounce from 'lodash.debounce';
import { getFileGitInfo, getGitCurrentHead, GitLineInfo } from './gitInfo';
import { TextEditorDecorationType } from 'vscode';

interface AuthorsDangerItem {
	/**
	 * The author dangers level(1-100)
	 */
	dangerLevel: number;
	/** The author email */
	author: string;
}

const DOMAIN_NAME = 'colorHim';
const AUTHORS_DANGER_CONFIG_KEY = `${DOMAIN_NAME}.authorsDangerConfig`;
const SHOW_DANGER_COLORS_CONFIG_KEY = `${DOMAIN_NAME}.showDangerColors`;
const TOGGLE_SHOW_DANGER_COLORS_COMMAND_KEY = `${DOMAIN_NAME}.toggle`;

/** For performance, run color calculation ina debounce */
const DEFAULT_UPDATE_DEBOUNCE_MS = 700;
const AUTHORS_DANGERS_CONFIG_DELIMITER = ',';
const AUTHOR_AND_DANGER_CONFIG_DELIMITER = '=';


/** The pool of the color decorator (0-N-100 size), only one instance for a color */
const colorDecorationsPool = new Map<number, TextEditorDecorationType>();

/** A map of a decorator color show show for a given author email */
const colorDecorationByAuthor = new Map<string, TextEditorDecorationType | undefined>();

/** Hold git info per file */
const cacheFileGitInfo = new Map<string, GitLineInfo[]>();

/** Hold latest git head, once it will be changed clear @see cacheFileGitInfo cache */
let gitLatestKnownHead = '';

/** The authors danger level config collection */
let authorsDangerConfig: AuthorsDangerItem[];
/** The enable/disable color config */
let showDangerColors: boolean;

/** Re-read and load config */
function readConfigs() {
	try {
		showDangerColors = (vscode.workspace.getConfiguration().get(SHOW_DANGER_COLORS_CONFIG_KEY) as boolean);

		// Load authors danger level raw string config 
		const authorsDangerRawConfig = (vscode.workspace.getConfiguration().get(AUTHORS_DANGER_CONFIG_KEY)) as string;

		// Split by authors
		const authorsRawConfig = authorsDangerRawConfig.split(AUTHORS_DANGERS_CONFIG_DELIMITER);

		// Reset config collection
		authorsDangerConfig = [];

		// Reset cache of color decoration per author
		colorDecorationByAuthor.clear();

		// For each author in the configuration, split to email and level and add to the collection
		for (const authorRawConfig of authorsRawConfig) {
			const [email, dangerLevel] = authorRawConfig.split(AUTHOR_AND_DANGER_CONFIG_DELIMITER);
			authorsDangerConfig.push({
				author: email,
				dangerLevel: parseInt(dangerLevel),
			});
		}

	} catch (error: any) {
		console.error(`Could not parse configuration: ${error?.message}`);
	}
}


/**
 * Get color decoration instance from the pool
 * @param dangerLevel The danger level to get color decorator instance for
 * @returns A color decorator instance 
 */
function getColorDecorationByDangerLevel(dangerLevel: number): TextEditorDecorationType {
	// If there is a decorator for the given level return it
	if (colorDecorationsPool.has(dangerLevel)) {
		return colorDecorationsPool.get(dangerLevel) as TextEditorDecorationType;
	}

	// Create a new instance, keep it in the pool, and return it
	const colorDecoration = vscode.window.createTextEditorDecorationType({
		backgroundColor: `hsla(0, ${dangerLevel}%, 50%, 0.35)`,
		isWholeLine: true,
	});
	colorDecorationsPool.set(dangerLevel, colorDecoration);
	return colorDecoration;
}

/**
 * Calculate the color decoration to set for a given line 
 * @param gitLineInfo The line git info 
 * @param editorLineContent The line content (trimmed) from the opened editor
 * @returns A @see TextEditorDecorationType instance, or undefined if no color need to be set
 */
function calcLineColorDecoration(gitLineInfo: GitLineInfo, editorLineContent: string): TextEditorDecorationType | undefined {

	// If line modified, ignore the line
	if (!gitLineInfo || gitLineInfo.email === 'not.committed.yet') {
		return;
	}

	// Check if it's the same as last git commit (use ! for better performance)
	const lineModified = gitLineInfo.lineContent !== editorLineContent;
	// If not.. skip this line
	if (lineModified) {
		return;
	}

	// If the color decoration for given author already calculated, take it from the cache
	if (colorDecorationByAuthor.has(gitLineInfo.email)) {
		return colorDecorationByAuthor.get(gitLineInfo.email);
	}

	// Find author in the config
	const authorDangerConfig = authorsDangerConfig.find(c => c.author?.trim() === gitLineInfo?.email);

	// If it's not there, keep it as not defined for next
	if (!authorDangerConfig) {
		colorDecorationByAuthor.set(gitLineInfo.email, undefined);
		return;
	}

	// Get the decoration of given danger level
	const colorDecoration = getColorDecorationByDangerLevel(authorDangerConfig.dangerLevel);

	// Keep the decoration for further use
	colorDecorationByAuthor.set(gitLineInfo.email, colorDecoration);
	return colorDecoration;
}

/**
 * Get the opened document in the editor, full text lines content mapped by line index
 * @param editor The opened editor
 * @returns Lines content (trimmed) mapped by line index   
 */
function getEditorDocumentTextByLinesTrimmed(editor: vscode.TextEditor): { [lineIndex in string]: string } {

	// Set a selection to get all file content
	const newSelection = new vscode.Selection(0, 0, editor.document.lineCount, 0);

	// Get all the text
	const documentText = editor.document.getText(newSelection);

	const lineMap: { [lineIndex in string]: string } = {};

	// Split text to lines, and build the lines content map
	for (const [lineNumber, line] of documentText.split('\n').entries()) {
		lineMap[lineNumber] = line?.trim();
	}

	return lineMap;
}

/**
 * Get current document fit info
 * @param documentFilePath The document file path
 * @returns The document git info
 */
async function getDocumentGitInfo(documentFilePath: string): Promise<GitLineInfo[]> {
	// Get current git head
	const currentGitHead = await getGitCurrentHead(documentFilePath);

	// Uf ut was change since last check, clear git info cache and update gitLatestKnownHead 
	if (currentGitHead !== gitLatestKnownHead) {
		cacheFileGitInfo.clear();
		gitLatestKnownHead = currentGitHead;
	}

	// If info already cached, return it
	if (cacheFileGitInfo.has(documentFilePath)) {
		return cacheFileGitInfo.get(documentFilePath) as GitLineInfo[];
	}

	// Get info, and keep it for farther use
	const fileLinesGitInfo = await getFileGitInfo(documentFilePath);
	cacheFileGitInfo.set(documentFilePath, fileLinesGitInfo);
	return fileLinesGitInfo;
}

/**
 * Set color decoration per author at the document.
 * @param editor The opened editor
 */
async function setDocumentAuthorsDangerColor(editor: vscode.TextEditor) {

	// First, get git info on current doc
	const fileLinesGitInfo = await getDocumentGitInfo(editor.document.uri.fsPath);

	// Get all current document text map by lines index
	const linesContentMap = getEditorDocumentTextByLinesTrimmed(editor);

	// Map ranges to a given color decoration instance
	const decorationsColorRanges = new Map<TextEditorDecorationType, vscode.DecorationOptions[]>();

	// Start iterate of each line in file
	for (const gitLineInfo of fileLinesGitInfo) {
		// If, from some reason, there is no info, skip it
		if (!gitLineInfo) {
			continue;
		}

		// Get calculated decoration color 
		const decorationColor = calcLineColorDecoration(gitLineInfo, linesContentMap[gitLineInfo.lineIndex]);

		// If there is not decoration color to set, skip
		if (!decorationColor) {
			continue;
		}

		// Build a range instance for the given line
		const decorationRange = { range: new vscode.Range(gitLineInfo.lineIndex, 0, gitLineInfo.lineIndex, 0) };

		// If color decoration not yet exists, add iot to map with an empty ranges
		if (!decorationsColorRanges.has(decorationColor)) {
			decorationsColorRanges.set(decorationColor, []);
		}
		// Add given line range to the correct color decoration collection
		decorationsColorRanges.get(decorationColor)?.push(decorationRange);
	}

	// Finally, run on all color decoration instances, and set for them the range to be shown
	// Need anyway to run anyway on all decorations in the pool, to empty who that not need to be shown at all now
	for (const colorDecoration of colorDecorationsPool.values()) {
		// As default mark range as "show nowhere"
		let ranges: vscode.DecorationOptions[] = [];
		// If it's map in the color ranges, set the range need to be shown
		if (decorationsColorRanges.has(colorDecoration)) {
			ranges = decorationsColorRanges.get(colorDecoration) as [];
		}
		// Set the new decoration ranges
		editor.setDecorations(colorDecoration, ranges);
	}
}

/**
 * Hide all color decorations
 * @param editor The opened editor to "remove" from 
 */
async function removeAllColorDecorations(editor: vscode.TextEditor) {
	// Run on all decoration in the pool, and set an empty range to all
	for (const colorDecoration of colorDecorationsPool.values()) {
		editor.setDecorations(colorDecoration, []);
	}
}

/**
 * Trigger run-calculation of the required decoration on the editor document view
 */
const triggerColorDecorationDigest = debounce((activeEditor: vscode.TextEditor) => {
	if (showDangerColors) {
		setDocumentAuthorsDangerColor(activeEditor);
	} else {
		removeAllColorDecorations(activeEditor);
	}
}, DEFAULT_UPDATE_DEBOUNCE_MS);


export function activate(context: vscode.ExtensionContext) {
	let activeEditor = vscode.window.activeTextEditor;

	// Load config
	readConfigs();

	// If there is active editor, trigger the color calculation
	if (activeEditor) {
		triggerColorDecorationDigest(activeEditor);
	}

	// Subscribe to a toggle show command
	vscode.commands.registerCommand(TOGGLE_SHOW_DANGER_COLORS_COMMAND_KEY, () => {
		// Toggle mode, and keep new mode in the config
		showDangerColors = !showDangerColors;
		vscode.workspace.getConfiguration().update(SHOW_DANGER_COLORS_CONFIG_KEY, showDangerColors);
		// If there is an editor, trigger the color calculation
		if (activeEditor) {
			triggerColorDecorationDigest(activeEditor);
		}
	});

	// Subscribe to a new document selection
	vscode.window.onDidChangeActiveTextEditor((editor) => {
		activeEditor = editor;
		if (editor) {
			triggerColorDecorationDigest(editor);
		}
	}, null, context.subscriptions);

	// Subscribe to a change in the document text
	vscode.workspace.onDidChangeTextDocument((event) => {
		if (activeEditor && event.document === activeEditor.document) {
			triggerColorDecorationDigest(activeEditor);
		}
	}, null, context.subscriptions);

	// Subscribe to a change in the configuration
	vscode.workspace.onDidChangeConfiguration((event) => {
		readConfigs();
	});
}