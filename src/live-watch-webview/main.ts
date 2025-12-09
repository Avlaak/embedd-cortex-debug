// Live Watch WebView client-side script

interface VsCodeApi {
    postMessage(message: any): void;
    getState(): any;
    setState(state: any): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface VariableNode {
    id: string;
    name: string;
    expr: string;
    value: string;
    type: string;
    hasChildren: boolean;
    expanded: boolean;
    changed: boolean;
    isRoot: boolean;
    children?: VariableNode[];
    depth: number;
}

interface LiveWatchMessage {
    type: 'update' | 'clear' | 'hint' | 'add-expression';
    variables?: VariableNode[];
    hintText?: string;
    hasSession?: boolean;
}

class LiveWatchView {
    private vscode: VsCodeApi;
    private root: HTMLElement;
    private variables: VariableNode[] = [];
    private selectedId: string | null = null;
    private hasSession: boolean = false;
    private editingNodeId: string | null = null;

    constructor() {
        this.vscode = acquireVsCodeApi();
        this.root = document.getElementById('live-watch-root')!;

        window.addEventListener('message', this.handleMessage.bind(this));

        // Restore state
        const state = this.vscode.getState();
        if (state) {
            this.variables = state.variables || [];
            this.hasSession = state.hasSession || false;
            this.render();
        }

        // Request initial data
        this.vscode.postMessage({ type: 'init' });
    }

    private handleMessage(event: MessageEvent<LiveWatchMessage>) {
        const message = event.data;

        switch (message.type) {
            case 'update':
                this.variables = message.variables || [];
                this.hasSession = message.hasSession ?? false;
                this.vscode.setState({ variables: this.variables, hasSession: this.hasSession });
                // Don't re-render if we're currently editing - just save the data
                if (!this.editingNodeId) {
                    this.render();
                }
                break;
            case 'clear':
                this.variables = [];
                this.hasSession = false;
                this.vscode.setState({ variables: [], hasSession: false });
                this.render();
                break;
            case 'hint':
                this.renderHint(message.hintText || '');
                break;
            case 'add-expression':
                this.showAddExpressionInput();
                break;
        }
    }

    private render() {
        this.root.innerHTML = '';

        if (this.variables.length === 0) {
            this.renderHint('Hint: Use & Enable "liveWatch" in your launch.json to enable this panel, and use the \'+\' button above to add new expressions');
            return;
        }

        for (const variable of this.variables) {
            this.renderNode(variable, this.root);
        }

        // Show hint about session if no active session
        if (!this.hasSession && this.variables.length > 0) {
            const hintDiv = document.createElement('div');
            hintDiv.className = 'hint-message';
            hintDiv.textContent = 'Hint: Use & Enable "liveWatch" in your launch.json to enable this panel';
            this.root.appendChild(hintDiv);
        }
    }

    private renderHint(text: string) {
        this.root.innerHTML = '';
        const hintDiv = document.createElement('div');
        hintDiv.className = 'hint-message';
        hintDiv.textContent = text;
        this.root.appendChild(hintDiv);
    }

    private showAddExpressionInput() {
        // Check if already showing
        let inputContainer = this.root.querySelector('.add-expression-container') as HTMLElement;
        if (inputContainer) {
            const input = inputContainer.querySelector('input');
            if (input) {
                input.focus();
            }
            return;
        }

        // Create container
        inputContainer = document.createElement('div');
        inputContainer.className = 'tree-item add-expression-container';
        
        // Toggle placeholder (invisible)
        const toggle = document.createElement('span');
        toggle.className = 'tree-toggle no-children';
        inputContainer.appendChild(toggle);

        // Content
        const content = document.createElement('div');
        content.className = 'tree-item-content';
        
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'inline-edit-input';
        input.placeholder = 'Expression to watch';
        input.style.width = '100%';
        
        content.appendChild(input);
        inputContainer.appendChild(content);
        
        this.root.appendChild(inputContainer);
        
        input.focus();
        
        // Event listeners
        const commit = () => {
            const value = input.value.trim();
            if (value) {
                this.vscode.postMessage({ type: 'add-expression', expression: value });
            }
            cleanup();
        };
        
        const cleanup = () => {
            if (inputContainer && inputContainer.parentNode) {
                inputContainer.parentNode.removeChild(inputContainer);
            }
            if (this.editingNodeId === 'add-expression') {
                this.editingNodeId = null;
                this.render();
            }
        };
        
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                commit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cleanup();
            }
        });
        
        input.addEventListener('blur', () => {
            // Commit on blur if there is a value
            const value = input.value.trim();
            if (value) {
                this.vscode.postMessage({ type: 'add-expression', expression: value });
            }
            cleanup();
        });
        
        this.editingNodeId = 'add-expression';
    }

    private renderNode(node: VariableNode, parent: HTMLElement) {
        const itemContainer = document.createElement('div');
        itemContainer.className = 'tree-item-container';
        itemContainer.dataset.id = node.id;

        const item = document.createElement('div');
        item.className = 'tree-item';
        if (this.selectedId === node.id) {
            item.classList.add('selected');
        }

        // Add indentation
        for (let i = 0; i < node.depth; i++) {
            const indent = document.createElement('span');
            indent.className = 'indent';
            item.appendChild(indent);
        }

        // Toggle button
        const toggle = document.createElement('span');
        toggle.className = 'tree-toggle';
        if (node.hasChildren) {
            toggle.classList.add(node.expanded ? 'expanded' : 'collapsed');
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleNode(node.id);
            });
        } else {
            toggle.classList.add('no-children');
        }
        item.appendChild(toggle);

        // Content
        const content = document.createElement('div');
        content.className = 'tree-item-content';

        const label = document.createElement('span');
        label.className = 'tree-label';

        // Parse name to show only the simple name (remove file prefix for global vars)
        const parts = node.name.startsWith('\'') && node.isRoot ? node.name.split('\'::') : [node.name];
        const displayName = parts.pop() || node.name;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'name';
        if (node.isRoot) {
            nameSpan.classList.add('editable');
        }
        nameSpan.textContent = displayName;

        // Inline editing for root nodes
        if (node.isRoot) {
            nameSpan.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this.startInlineEdit(node, nameSpan);
            });
        }

        label.appendChild(nameSpan);

        const separator = document.createElement('span');
        separator.className = 'separator';
        separator.textContent = '=';
        label.appendChild(separator);

        const valueSpan = document.createElement('span');
        valueSpan.className = 'value';
        if (!node.value || node.value === '') {
            valueSpan.textContent = 'not available';
            valueSpan.classList.add('not-available');
        } else {
            valueSpan.textContent = node.value;
            if (node.changed) {
                valueSpan.classList.add('changed');
            }

            // Add type classes
            if (node.value.startsWith('"') || node.value.startsWith("'")) {
                valueSpan.classList.add('string');
            } else if (node.value === 'true' || node.value === 'false') {
                valueSpan.classList.add('boolean');
            } else if (/^-?\d/.test(node.value) || /^0x[0-9a-fA-F]/.test(node.value)) {
                valueSpan.classList.add('number');
            } else if (node.value.startsWith('<')) {
                valueSpan.classList.add('error');
            }
        }

        // Inline value editing when session is active (only for leaf nodes)
        if (this.hasSession && node.value && node.value !== '' && !node.hasChildren) {
            valueSpan.classList.add('editable');
            valueSpan.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this.startInlineValueEdit(node, valueSpan);
            });
        }

        label.appendChild(valueSpan);

        // Set tooltip
        let tooltip = node.type || '';
        if (parts.length > 0) {
            const file = parts[0].slice(1);
            tooltip = 'File: ' + file + (tooltip ? '\n' + tooltip : '');
        }
        label.title = tooltip;

        content.appendChild(label);
        item.appendChild(content);

        // Action buttons for root children
        if (node.isRoot) {
            const actions = document.createElement('div');
            actions.className = 'tree-item-actions';

            // Set value button
            if (this.hasSession) {
                actions.appendChild(this.createActionButton('set-value', node.id, 'Set Value', this.getSetValueIcon()));
            }

            // Edit button
            actions.appendChild(this.createActionButton('edit', node.id, 'Edit expression', this.getEditIcon()));

            // Move up button
            actions.appendChild(this.createActionButton('move-up', node.id, 'Move expression up', this.getArrowUpIcon()));

            // Move down button
            actions.appendChild(this.createActionButton('move-down', node.id, 'Move expression down', this.getArrowDownIcon()));

            // Remove button
            actions.appendChild(this.createActionButton('remove', node.id, 'Remove expression', this.getCloseIcon()));

            item.appendChild(actions);
        } else if (this.hasSession) {
            // Set value button for non-root nodes
            const actions = document.createElement('div');
            actions.className = 'tree-item-actions';
            actions.appendChild(this.createActionButton('set-value', node.id, 'Set Value', this.getSetValueIcon()));
            item.appendChild(actions);
        }

        item.addEventListener('click', () => {
            this.selectNode(node.id);
        });

        item.addEventListener('dblclick', (e) => {
            // Only toggle for non-root nodes with children
            // Root nodes use inline edit on name double-click
            if (!node.isRoot && node.hasChildren) {
                this.toggleNode(node.id);
            }
        });

        itemContainer.appendChild(item);

        // Children container
        if (node.children && node.children.length > 0) {
            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'tree-children';
            if (node.expanded) {
                childrenContainer.classList.add('expanded');
            }

            for (const child of node.children) {
                this.renderNode(child, childrenContainer);
            }

            itemContainer.appendChild(childrenContainer);
        }

        parent.appendChild(itemContainer);
    }

    private createActionButton(action: string, nodeId: string, title: string, iconSvg: string): HTMLButtonElement {
        const button = document.createElement('button');
        button.className = 'action-button';
        button.title = title;
        button.innerHTML = iconSvg;
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            this.vscode.postMessage({ type: 'action', action, nodeId });
        });
        return button;
    }

    private selectNode(id: string) {
        this.selectedId = id;
        // Remove selection from all items
        this.root.querySelectorAll('.tree-item.selected').forEach((el) => {
            el.classList.remove('selected');
        });
        // Add selection to clicked item
        const container = this.root.querySelector(`[data-id="${id}"]`);
        if (container) {
            const item = container.querySelector('.tree-item');
            if (item) {
                item.classList.add('selected');
            }
        }
    }

    private toggleNode(id: string) {
        this.vscode.postMessage({ type: 'toggle', nodeId: id });
    }

    private startInlineEdit(node: VariableNode, nameSpan: HTMLElement) {
        if (this.editingNodeId) {
            return; // Already editing
        }

        this.editingNodeId = node.id;

        const currentName = node.name;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'inline-edit-input';
        input.value = currentName;

        const parent = nameSpan.parentElement;
        if (!parent) {
            return;
        }

        // Hide the name span and separator + value temporarily
        const separator = parent.querySelector('.separator') as HTMLElement;
        const valueSpan = parent.querySelector('.value') as HTMLElement;

        nameSpan.style.display = 'none';
        if (separator) {
            separator.style.display = 'none';
        }
        if (valueSpan) {
            valueSpan.style.display = 'none';
        }

        parent.insertBefore(input, nameSpan);
        input.focus();
        input.select();

        const finishEdit = (save: boolean) => {
            if (this.editingNodeId !== node.id) {
                return; // Already finished
            }

            this.editingNodeId = null;
            const newValue = input.value.trim();

            // Restore visibility
            nameSpan.style.display = '';
            if (separator) {
                separator.style.display = '';
            }
            if (valueSpan) {
                valueSpan.style.display = '';
            }

            // Remove input
            if (input.parentElement) {
                input.parentElement.removeChild(input);
            }

            // Save if changed
            if (save && newValue && newValue !== currentName) {
                this.vscode.postMessage({
                    type: 'inline-rename',
                    nodeId: node.id,
                    newName: newValue
                });
            } else {
                // Re-render to apply any updates that were skipped during editing
                this.render();
            }
        };

        input.addEventListener('blur', () => {
            finishEdit(true);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                finishEdit(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                finishEdit(false);
            }
        });
    }

    private startInlineValueEdit(node: VariableNode, valueSpan: HTMLElement) {
        if (this.editingNodeId) {
            return; // Already editing
        }

        this.editingNodeId = node.id;

        const currentValue = node.value;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'inline-edit-input';
        input.value = currentValue;

        const parent = valueSpan.parentElement;
        if (!parent) {
            return;
        }

        // Hide the value span temporarily
        valueSpan.style.display = 'none';

        parent.insertBefore(input, valueSpan);
        input.focus();
        input.select();

        const finishEdit = (save: boolean) => {
            if (this.editingNodeId !== node.id) {
                return; // Already finished
            }

            this.editingNodeId = null;
            const newValue = input.value.trim();

            // Restore visibility
            valueSpan.style.display = '';

            // Remove input
            if (input.parentElement) {
                input.parentElement.removeChild(input);
            }

            // Save if changed
            if (save && newValue !== currentValue) {
                this.vscode.postMessage({
                    type: 'inline-set-value',
                    nodeId: node.id,
                    newValue: newValue
                });
            } else {
                // Re-render to apply any updates that were skipped during editing
                this.render();
            }
        };

        input.addEventListener('blur', () => {
            finishEdit(true);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                finishEdit(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                finishEdit(false);
            }
        });
    }

    // SVG Icons
    private getCloseIcon(): string {
        return '<svg viewBox="0 0 16 16"><path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646' +
            '-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z"/></svg>';
    }

    private getEditIcon(): string {
        return '<svg viewBox="0 0 16 16"><path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l8-8 1.77 1.77-8 8z"/></svg>';
    }

    private getArrowUpIcon(): string {
        return '<svg viewBox="0 0 16 16"><path d="M3.5 7.5L8 3l4.5 4.5H9v5H7v-5H3.5z"/></svg>';
    }

    private getArrowDownIcon(): string {
        return '<svg viewBox="0 0 16 16"><path d="M12.5 8.5L8 13 3.5 8.5H7v-5h2v5h3.5z"/></svg>';
    }

    private getSetValueIcon(): string {
        return '<svg viewBox="0 0 16 16"><path d="M4 6h8v1H4V6zm0 3h8v1H4V9zm0 3h5v1H4v-1z"/></svg>';
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new LiveWatchView());
} else {
    new LiveWatchView();
}
