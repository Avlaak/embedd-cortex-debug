import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { getPathRelative, LiveWatchConfig } from '../../common';
import { DebugProtocol } from '@vscode/debugprotocol';

interface SaveVarState {
    id: string;
    expanded: boolean;
    value: string;
    children: LiveVariableNode[] | undefined;
}

interface SaveVarStateMap {
    [name: string]: SaveVarState;
}

interface WebViewVariableNode {
    id: string;
    name: string;
    expr: string;
    value: string;
    type: string;
    hasChildren: boolean;
    expanded: boolean;
    changed: boolean;
    isRoot: boolean;
    children?: WebViewVariableNode[];
    depth: number;
}

export class LiveVariableNode {
    protected session: vscode.DebugSession | undefined;
    protected children: LiveVariableNode[] | undefined;
    protected prevValue: string = '';
    public expanded: boolean = false;
    private id: string;
    private static idCounter = 0;

    constructor(
        protected parent: LiveVariableNode | undefined,
        protected name: string,
        protected expr: string,
        protected value = '',
        protected type = '',
        protected variablesReference = 0
    ) {
        this.id = `node_${LiveVariableNode.idCounter++}`;
    }

    public getId(): string {
        return this.id;
    }

    public setId(id: string) {
        this.id = id;
    }

    public getExpr(): string {
        return this.expr;
    }

    public getChildren(): LiveVariableNode[] {
        return this.children ?? [];
    }

    public hasChildrenNodes(): boolean {
        return this.variablesReference > 0 || (this.children?.length ?? 0) > 0;
    }

    public isRootChild(): boolean {
        const node = this.parent;
        return node && (node.getParent() === undefined);
    }

    public rename(nm: string) {
        if (this.isRootChild()) {
            this.name = this.expr = nm;
        }
    }

    public getName() {
        return this.name;
    }

    public getValue() {
        return this.value;
    }

    public getType() {
        return this.type;
    }

    public getVariablesReference() {
        return this.variablesReference;
    }

    public getParent(): LiveVariableNode | undefined {
        return this.parent;
    }

    public isValueChanged(): boolean {
        return this.prevValue !== '' && this.prevValue !== this.value;
    }

    public findName(str: string): LiveVariableNode | undefined {
        for (const child of this.children || []) {
            if (child.name === str) {
                return child;
            }
        }
        return undefined;
    }

    public findById(id: string): LiveVariableNode | undefined {
        if (this.id === id) {
            return this;
        }
        for (const child of this.children || []) {
            const found = child.findById(id);
            if (found) {
                return found;
            }
        }
        return undefined;
    }

    public toWebViewNode(depth: number = 0, cwd?: string): WebViewVariableNode {
        const parts = this.name.startsWith('\'') && this.isRootChild() ? this.name.split('\'::') : [this.name];
        const displayName = parts.pop() || this.name;

        let file = parts.length ? parts[0].slice(1) : '';
        if (file && cwd) {
            file = getPathRelative(cwd, file);
        }

        const changed = this.isValueChanged();
        const node: WebViewVariableNode = {
            id: this.id,
            name: this.name,
            expr: this.expr,
            value: this.value || '',
            type: (file ? 'File: ' + file + '\n' : '') + this.type,
            hasChildren: this.hasChildrenNodes(),
            expanded: this.expanded,
            changed: changed,
            isRoot: this.isRootChild(),
            depth: depth,
            children: this.expanded ? this.children?.map((c) => c.toWebViewNode(depth + 1, cwd)) : undefined
        };

        this.prevValue = this.value;
        return node;
    }

    public addChild(name: string, expr: string = '', value = '', type = '', reference = 0): LiveVariableNode {
        if (!this.children) {
            this.children = [];
        }
        const child = new LiveVariableNode(this, name, expr || name, value, type, reference);
        this.children.push(child);
        return child;
    }

    public removeChild(node: LiveVariableNode): boolean {
        if (!node || !node.isRootChild()) { return false; }
        let ix = 0;
        for (const child of this.children || []) {
            if (child.name === node.name) {
                this.children.splice(ix, 1);
                return true;
            }
            ix++;
        }
        return false;
    }

    public moveUpChild(node: LiveVariableNode): boolean {
        if (!node || !node.isRootChild()) { return false; }
        let ix = 0;
        for (const child of this.children || []) {
            if (child.name === node.name) {
                if (ix > 0) {
                    const prev = this.children[ix - 1];
                    this.children[ix] = prev;
                    this.children[ix - 1] = child;
                } else {
                    const first = this.children.shift();
                    this.children.push(first);
                }
                return true;
            }
            ix++;
        }
        return false;
    }

    public moveDownChild(node: LiveVariableNode): boolean {
        if (!node || !node.isRootChild()) { return false; }
        let ix = 0;
        const last = this.children ? this.children.length - 1 : -1;
        for (const child of this.children || []) {
            if (child.name === node.name) {
                if (ix !== last) {
                    const next = this.children[ix + 1];
                    this.children[ix] = next;
                    this.children[ix + 1] = child;
                } else {
                    const lastItem = this.children.pop();
                    this.children.unshift(lastItem);
                }
                return true;
            }
            ix++;
        }
        return false;
    }

    public reset(valuesToo = true) {
        this.session = undefined;
        if (valuesToo) {
            this.value = this.type = this.prevValue = '';
            this.variablesReference = 0;
        }
        for (const child of this.children || []) {
            child.reset(valuesToo);
        }
    }

    private namedVariables: number = 0;
    private indexedVariables: number = 0;

    private refreshChildren(session: vscode.DebugSession, resolve: () => void) {
        if (!session || (this.session !== session)) {
            resolve();
        } else if (this.expanded && (this.variablesReference > 0)) {
            const varg: DebugProtocol.VariablesArguments = {
                variablesReference: this.variablesReference
            };
            const oldStateMap: SaveVarStateMap = {};
            for (const child of this.children ?? []) {
                oldStateMap[child.name] = {
                    id: child.getId(),
                    expanded: child.expanded,
                    value: child.value,
                    children: child.children
                };
            }
            this.session.customRequest('liveVariables', varg).then((result) => {
                if (!result?.variables?.length) {
                    this.children = undefined;
                } else {
                    this.children = [];
                    for (const variable of result.variables ?? []) {
                        const ch = new LiveVariableNode(
                            this,
                            variable.name,
                            variable.evaluateName || variable.name,
                            variable.value || '',
                            variable.type || '',
                            variable.variablesReference ?? 0);
                        const oldState = oldStateMap[ch.name];
                        if (oldState) {
                            ch.setId(oldState.id);
                            ch.expanded = oldState.expanded && (ch.variablesReference > 0);
                            ch.prevValue = oldState.value;
                            ch.children = oldState.children;
                        }
                        ch.session = session;
                        this.children.push(ch);
                    }
                }
                const promises: Promise<void>[] = [];
                for (const child of this.children ?? []) {
                    if (child.expanded) {
                        const p = new Promise<void>((res) => {
                            child.refreshChildren(session, res);
                        });
                        promises.push(p);
                    }
                }
                Promise.allSettled(promises).finally(() => {
                    resolve();
                });
            }, () => {
                resolve();
            });
        } else {
            resolve();
        }
    }

    public expandChildren(session: vscode.DebugSession): Promise<void> {
        return new Promise<void>((resolve) => {
            this.expanded = true;
            this.session = session;
            this.refreshChildren(session, resolve);
        });
    }

    public refresh(session: vscode.DebugSession): Promise<void> {
        return new Promise<void>((resolve) => {
            this.session = session;
            if (this.expr) {
                const arg: DebugProtocol.EvaluateArguments = {
                    expression: this.expr,
                    context: 'hover'
                };
                session.customRequest('liveEvaluate', arg).then((result) => {
                    if (result && result.result !== undefined) {
                        const oldType = this.type;
                        this.value = result.result;
                        this.type = result.type;
                        this.variablesReference = result.variablesReference ?? 0;
                        this.namedVariables = result.namedVariables ?? 0;
                        this.indexedVariables = result.indexedVariables ?? 0;
                        if (oldType !== this.type) {
                            this.children = this.variablesReference ? [] : undefined;
                        }
                        this.refreshChildren(session, resolve);
                    } else {
                        this.value = `<Failed to evaluate ${this.expr}>`;
                        this.children = undefined;
                        resolve();
                    }
                }, () => {
                    resolve();
                });
            } else if (this.children && !this.parent) {
                // This is the root node
                const promises: Promise<void>[] = [];
                for (const child of this.children) {
                    promises.push(child.refresh(session));
                }
                Promise.allSettled(promises).finally(() => {
                    resolve();
                });
            } else {
                this.refreshChildren(session, resolve);
            }
        });
    }

    public addNewExpr(expr: string): boolean {
        if (this.parent) {
            return false;
        }
        for (const child of this.children || []) {
            if (expr === child.expr) {
                return false;
            }
        }
        this.addChild(expr, expr);
        return true;
    }

    private pvtSerialize(state: NodeState | undefined): NodeState {
        const item: NodeState = {
            name: this.name,
            expr: this.expr,
            expanded: this.expanded || !this.parent,
            children: []
        };
        if (!state) {
            state = item;
        } else {
            state.children.push(item);
        }
        for (const child of this.children ?? []) {
            child.pvtSerialize(item);
        }
        return item;
    }

    public serialize(): NodeState {
        return this.pvtSerialize(undefined);
    }

    public deSerialize(state: NodeState): void {
        for (const child of state.children) {
            if (!this.children) {
                this.children = [];
            }
            const item = new LiveVariableNode(this, child.name, child.expr);
            item.expanded = child.expanded;
            this.children.push(item);
            item.deSerialize(child);
        }
    }
}

interface NodeState {
    name: string;
    expr: string;
    expanded: boolean;
    children: NodeState[];
}

const VERSION_ID = 'livewatch.version';
const WATCH_LIST_STATE = 'livewatch.watchTree';

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export class LiveWatchWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'cortex-debug.liveWatch';

    private static stateVersion = 2;
    private variables: LiveVariableNode;
    public static session: vscode.DebugSession | undefined;
    private timeout: NodeJS.Timeout | undefined;
    private timeoutMs: number = 250;
    private isStopped = true;
    private webviewView: vscode.WebviewView | undefined;

    private static defaultRefreshRate = 300;
    private static minRefreshRate = 200;
    private static maxRefreshRate = 5000;
    private currentRefreshRate = LiveWatchWebviewProvider.defaultRefreshRate;

    constructor(private context: vscode.ExtensionContext) {
        this.variables = new LiveVariableNode(undefined, '', '');
        this.setRefreshRate();
        this.restoreState();
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(this.settingsChanged.bind(this))
        );
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this.webviewView = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(this.context.extensionPath, 'dist')),
                vscode.Uri.file(path.join(this.context.extensionPath, 'resources'))
            ]
        };

        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(this.handleMessage.bind(this));

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.updateWebview();
            }
        });

        webviewView.onDidDispose(() => {
            this.webviewView = undefined;
        });

        // Initial update
        this.updateWebview();
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'live-watch.bundle.js'))
        );

        const nonce = getNonce();

        let html = fs.readFileSync(
            path.join(this.context.extensionPath, 'resources', 'live-watch.html'),
            { encoding: 'utf8', flag: 'r' }
        );
        html = html.replace(/\$\{nonce\}/g, nonce).replace(/\$\{scriptUri\}/g, scriptUri.toString());

        return html;
    }

    private handleMessage(message: any) {
        switch (message.type) {
            case 'init':
                this.updateWebview();
                break;
            case 'toggle':
                this.toggleNode(message.nodeId);
                break;
            case 'action':
                this.handleAction(message.action, message.nodeId);
                break;
            case 'inline-rename':
                this.handleInlineRename(message.nodeId, message.newName);
                break;
            case 'inline-set-value':
                this.handleInlineSetValue(message.nodeId, message.newValue);
                break;
            case 'add-expression':
                this.addWatchExpr(message.expression, LiveWatchWebviewProvider.session);
                break;
            case 'update-format':
                this.handleUpdateFormat(message.nodeId, message.format);
                break;
        }
    }

    public triggerAddExpression() {
        if (this.webviewView) {
            this.webviewView.webview.postMessage({ type: 'add-expression' });
        }
    }

    private handleInlineSetValue(nodeId: string, newValue: string) {
        if (!LiveWatchWebviewProvider.session) {
            vscode.window.showWarningMessage('Live Watch: No active debug session');
            this.updateWebview();
            return;
        }

        const node = this.variables.findById(nodeId);
        if (!node) {
            this.updateWebview();
            return;
        }

        const args = {
            expression: node.getExpr(),
            value: newValue
        };
        LiveWatchWebviewProvider.session.customRequest('liveSetValue', args).then(() => {
            this.refresh(LiveWatchWebviewProvider.session);
        }, (err) => {
            vscode.window.showErrorMessage(`Live Watch: Failed to set value: ${err}`);
            this.updateWebview();
        });
    }

    private handleInlineRename(nodeId: string, newName: string) {
        const node = this.variables.findById(nodeId);
        if (!node || !node.isRootChild()) {
            return;
        }

        newName = newName.trim();
        if (!newName || newName === node.getName()) {
            return;
        }

        // Check if expression already exists
        if (this.variables.findName(newName)) {
            vscode.window.showInformationMessage(
                `Live Watch: Expression ${newName} is already being watched`
            );
            return;
        }

        node.rename(newName);
        this.saveState();
        this.refresh(LiveWatchWebviewProvider.session);
    }

    private handleUpdateFormat(nodeId: string, format: string) {
        const node = this.variables.findById(nodeId);
        if (!node || !node.isRootChild()) {
            return;
        }

        let expr = node.getExpr();
        // Remove existing format specifier if any (e.g. ,h ,x ,b ,o ,d)
        // Regex to match comma followed by format chars at the end
        expr = expr.replace(/,[hxbod]$/, '');

        if (format) {
            expr += ',' + format;
        }

        if (expr === node.getExpr()) {
            return;
        }

        // Check if expression already exists
        if (this.variables.findName(expr)) {
            vscode.window.showInformationMessage(
                `Live Watch: Expression ${expr} is already being watched`
            );
            return;
        }

        node.rename(expr);
        this.saveState();
        this.refresh(LiveWatchWebviewProvider.session);
    }

    private handleAction(action: string, nodeId: string) {
        const node = this.variables.findById(nodeId);
        if (!node) {
            return;
        }

        switch (action) {
            case 'remove':
                this.removeWatchExpr(node);
                break;
            case 'edit':
                this.editNode(node);
                break;
            case 'set-value':
                this.setValueNode(node);
                break;
            case 'move-up':
                this.moveUpNode(node);
                break;
            case 'move-down':
                this.moveDownNode(node);
                break;
        }
    }

    private toggleNode(nodeId: string) {
        const node = this.variables.findById(nodeId);
        if (node) {
            if (node.expanded) {
                node.expanded = false;
                this.saveState();
                this.updateWebview();
            } else {
                if (LiveWatchWebviewProvider.session) {
                    node.expandChildren(LiveWatchWebviewProvider.session).then(() => {
                        this.saveState();
                        this.updateWebview();
                    });
                } else {
                    node.expanded = true;
                    this.saveState();
                    this.updateWebview();
                }
            }
        }
    }

    private updateWebview() {
        if (!this.webviewView) {
            return;
        }

        const cwd = LiveWatchWebviewProvider.session?.configuration?.cwd;
        const children = this.variables.getChildren();
        const webViewNodes = children.map((c) => c.toWebViewNode(0, cwd));

        this.webviewView.webview.postMessage({
            type: 'update',
            variables: webViewNodes,
            hasSession: !!LiveWatchWebviewProvider.session
        });
    }

    private restoreState() {
        try {
            const state = this.context.workspaceState;
            const ver = state.get(VERSION_ID) ?? LiveWatchWebviewProvider.stateVersion;
            if (ver === LiveWatchWebviewProvider.stateVersion) {
                const data = state.get(WATCH_LIST_STATE);
                const saved = data as NodeState;
                if (saved) {
                    this.variables.deSerialize(saved);
                }
            }
        } catch (error) {
            console.error('live-watch.restoreState', error);
        }
    }

    private settingsChanged(e: vscode.ConfigurationChangeEvent) {
        if (e.affectsConfiguration('cortex-debug.liveWatchRefreshRate')) {
            this.setRefreshRate();
        }
    }

    private setRefreshRate() {
        const config = vscode.workspace.getConfiguration('cortex-debug', null);
        let rate = config.get('liveWatchRefreshRate', LiveWatchWebviewProvider.defaultRefreshRate);
        rate = Math.max(rate, LiveWatchWebviewProvider.minRefreshRate);
        rate = Math.min(rate, LiveWatchWebviewProvider.maxRefreshRate);
        this.currentRefreshRate = rate;
    }

    public saveState() {
        const state = this.context.workspaceState;
        const data = this.variables.serialize();
        state.update(VERSION_ID, LiveWatchWebviewProvider.stateVersion);
        state.update(WATCH_LIST_STATE, data);
    }

    private isSameSession(session: vscode.DebugSession): boolean {
        if (session && LiveWatchWebviewProvider.session && (session.id === LiveWatchWebviewProvider.session.id)) {
            return true;
        }
        return false;
    }

    public refresh(session: vscode.DebugSession, restartTimer = false): void {
        if (session && this.isSameSession(session)) {
            const restart = (elapsed: number) => {
                if (!this.isStopped && restartTimer && LiveWatchWebviewProvider.session) {
                    this.startTimer(((elapsed < 0) || (elapsed > this.timeoutMs)) ? 0 : elapsed);
                }
            };
            if (this.variables.getChildren().length === 0) {
                restart(0);
            } else {
                const start = Date.now();
                session.customRequest('liveCacheRefresh', {
                    deleteAll: false
                }).then(() => {
                    this.variables.refresh(session).finally(() => {
                        const elapsed = Date.now() - start;
                        this.updateWebview();
                        if (elapsed > this.timeoutMs) {
                            console.error('??????? over flow ????');
                        }
                        restart(elapsed);
                    });
                });
            }
        } else {
            this.updateWebview();
        }
    }

    private startTimer(subtract: number = 0) {
        this.killTimer();
        this.timeout = setTimeout(() => {
            this.timeout = undefined;
            if (LiveWatchWebviewProvider.session) {
                this.refresh(LiveWatchWebviewProvider.session, true);
            }
        }, this.timeoutMs - subtract);
    }

    private killTimer() {
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = undefined;
        }
    }

    public debugSessionTerminated(session: vscode.DebugSession) {
        if (this.isSameSession(session)) {
            this.isStopped = true;
            this.killTimer();
            LiveWatchWebviewProvider.session = undefined;
            this.updateWebview();
            this.saveState();
            setTimeout(() => {
                this.variables.reset(true);
            }, 100);
        }
    }

    public debugSessionStarted(session: vscode.DebugSession) {
        const liveWatch = session.configuration.liveWatch as LiveWatchConfig;
        if (!liveWatch?.enabled) {
            if (!LiveWatchWebviewProvider.session) {
                this.updateWebview();
            }
            return;
        }
        if (LiveWatchWebviewProvider.session) {
            vscode.window.showErrorMessage(
                'Error: You can have live-watch enabled to only one debug session at a time. Live Watch is already enabled for '
                + LiveWatchWebviewProvider.session.name);
            return;
        }
        LiveWatchWebviewProvider.session = session;
        this.isStopped = true;
        this.variables.reset();
        const samplesPerSecond = Math.max(1, Math.min(20, liveWatch.samplesPerSecond ?? 4));
        this.timeoutMs = 1000 / samplesPerSecond;
        this.startTimer();
    }

    public debugStopped(session: vscode.DebugSession) {
        if (this.isSameSession(session)) {
            this.isStopped = true;
            this.killTimer();
            setTimeout(() => {
                if (!this.timeout) {
                    this.refresh(LiveWatchWebviewProvider.session);
                }
            }, 250);
        }
    }

    public debugContinued(session: vscode.DebugSession) {
        if (this.isSameSession(session)) {
            this.isStopped = false;
            this.startTimer();
        }
    }

    public addWatchExpr(expr: string, _session: vscode.DebugSession) {
        expr = expr.trim();
        if (expr && this.variables.addNewExpr(expr)) {
            this.saveState();
            this.refresh(LiveWatchWebviewProvider.session);
        }
    }

    public removeWatchExpr(node: LiveVariableNode) {
        try {
            if (this.variables.removeChild(node)) {
                this.saveState();
                this.updateWebview();
            }
        } catch (e) {
            console.error('Failed to remove node. Invalid node?', node);
        }
    }

    public removeAllExpr() {
        const children = this.variables.getChildren();
        if (children.length > 0) {
            for (const child of [...children]) {
                this.variables.removeChild(child);
            }
            this.saveState();
            this.updateWebview();
        }
    }

    public collapseAll() {
        const children = this.variables.getChildren();
        let changed = false;
        for (const child of children) {
            if (child.expanded) {
                child.expanded = false;
                changed = true;
            }
        }
        if (changed) {
            this.saveState();
            this.updateWebview();
        }
    }

    public editNode(node: LiveVariableNode) {
        if (!node.isRootChild()) {
            return;
        }
        const opts: vscode.InputBoxOptions = {
            placeHolder: 'Enter a valid C/gdb expression. Must be a global variable expression',
            ignoreFocusOut: true,
            value: node.getName(),
            prompt: 'Enter Live Watch Expression'
        };
        vscode.window.showInputBox(opts).then((result) => {
            result = result ? result.trim() : result;
            if (result && (result !== node.getName())) {
                if (this.variables.findName(result)) {
                    vscode.window.showInformationMessage(`Live Watch: Expression ${result} is already being watched`);
                } else {
                    node.rename(result);
                    this.saveState();
                    this.refresh(LiveWatchWebviewProvider.session);
                }
            }
        });
    }

    public setValueNode(node: LiveVariableNode) {
        if (!LiveWatchWebviewProvider.session) {
            vscode.window.showWarningMessage('Live Watch: No active debug session');
            return;
        }
        const currentValue = node.getValue();
        const opts: vscode.InputBoxOptions = {
            placeHolder: 'Enter the new value for the variable',
            ignoreFocusOut: true,
            value: currentValue,
            prompt: `Set value for ${node.getName()}`
        };
        vscode.window.showInputBox(opts).then((result) => {
            result = result !== undefined ? result.trim() : undefined;
            if (result !== undefined && result !== currentValue) {
                const args = {
                    expression: node.getExpr(),
                    value: result
                };
                LiveWatchWebviewProvider.session.customRequest('liveSetValue', args).then(() => {
                    this.refresh(LiveWatchWebviewProvider.session);
                }, (err) => {
                    vscode.window.showErrorMessage(`Live Watch: Failed to set value: ${err}`);
                });
            }
        });
    }

    public moveUpNode(node: LiveVariableNode) {
        const parent = node?.getParent();
        if (parent && parent.moveUpChild(node)) {
            this.saveState();
            this.updateWebview();
        }
    }

    public moveDownNode(node: LiveVariableNode) {
        const parent = node?.getParent();
        if (parent && parent.moveDownChild(node)) {
            this.saveState();
            this.updateWebview();
        }
    }

    public expandChildren(element: LiveVariableNode) {
        if (element && LiveWatchWebviewProvider.session) {
            element.expandChildren(LiveWatchWebviewProvider.session).then(() => {
                this.updateWebview();
            });
        }
    }

    public findNodeById(id: string): LiveVariableNode | undefined {
        return this.variables.findById(id);
    }
}

// Keep old export name for compatibility during transition
export { LiveWatchWebviewProvider as LiveWatchTreeProvider };
