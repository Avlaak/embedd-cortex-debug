/**
 * Utility functions for expression parsing and validation.
 */

/**
 * Check if expression is a simple variable (lvalue) that can be assigned to.
 * Simple variables: identifiers, struct members (a.b, a->b), array elements (a[0], a[i+1]),
 * pointer dereferences (*ptr), and variables with format specifiers (var,x).
 * Non-assignable: arithmetic expressions (a+b), function calls, literals, etc.
 *
 * Note: Array index expressions like arr[i+1] ARE lvalues because the result
 * is a memory location that can be assigned to. The expression inside [] is
 * computed to get the index, but the result is still addressable.
 */
export function isEditableVariable(expr: string): boolean {
    // Remove format specifier if present (e.g., ",x" or ",h" at the end)
    const exprWithoutFormat = expr.replace(/,[hxbod]$/i, '').trim();

    if (!exprWithoutFormat) {
        return false;
    }

    // Check for pure numeric literals (not lvalues) - must check before operators
    // Matches: 42, -42, 3.14, -3.14, 0x1234, 0xABCD
    if (/^-?\d+(\.\d+)?$/.test(exprWithoutFormat) || /^0x[0-9a-fA-F]+$/i.test(exprWithoutFormat)) {
        return false;
    }

    // Check for string literals
    if (/^["']/.test(exprWithoutFormat)) {
        return false;
    }

    // Check for function/method calls or casts: identifier followed by (
    // This catches: func(), obj.method(), sizeof(int), (int)x
    if (/[a-zA-Z_]\w*\s*\(/.test(exprWithoutFormat) || /^\s*\(/.test(exprWithoutFormat)) {
        return false;
    }

    // Remove content inside square brackets for operator checking
    // Array index expressions (arr[i+1]) are still lvalues - only the outer expression matters
    // We replace [...] with [0] to preserve structure but remove inner operators
    const exprWithMaskedBrackets = maskBracketContents(exprWithoutFormat);

    // List of binary operators that indicate computed expressions
    // Order matters for multi-char operators
    const binaryOperators = [
        '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
        '+', '/', '%', '^', '?', ':'
    ];

    // Check for binary operators (these always indicate non-lvalue)
    for (const op of binaryOperators) {
        const idx = exprWithMaskedBrackets.indexOf(op);
        if (idx >= 0) {
            // Special case: '>>' and '>=' - make sure it's not part of '->'
            if ((op === '>>' || op === '>=') && idx > 0 && exprWithMaskedBrackets[idx - 1] === '-') {
                continue; // This is '->' followed by '>' or '=', not a shift/comparison
            }
            return false;
        }
    }

    // Special handling for '-' (could be unary minus at start, or subtraction, or arrow ->)
    // Allow: *-ptr (dereference of negative?), ptr->member
    // Disallow: a-b, 10-5
    // Pattern: something - something (where it's not arrow ->)
    if (/[a-zA-Z0-9_\]]\s*-\s*(?!>)[a-zA-Z0-9_]/.test(exprWithMaskedBrackets)) {
        return false;
    }

    // Special handling for '*' (could be pointer dereference or multiplication)
    // Allow: *ptr, **ptr, arr[*ptr] (but brackets are masked, so just *ptr, **ptr)
    // Disallow: a*b, 2*3
    // Multiplication has operands on both sides
    if (/[a-zA-Z0-9_\]]\s*\*\s*[a-zA-Z0-9_]/.test(exprWithMaskedBrackets)) {
        return false;
    }

    // Special handling for '&' (could be address-of or bitwise AND)
    // Allow: &var (address-of at start)
    // Disallow: a&b (bitwise AND)
    if (/[a-zA-Z0-9_\]]\s*&\s*[a-zA-Z0-9_]/.test(exprWithMaskedBrackets)) {
        return false;
    }

    // Special handling for '|' (bitwise OR)
    if (exprWithMaskedBrackets.includes('|')) {
        return false;
    }

    // Special handling for '~' (bitwise NOT - unary, result is not lvalue)
    if (exprWithMaskedBrackets.includes('~')) {
        return false;
    }

    // Special handling for '!' (logical NOT - unary, result is not lvalue)
    // But be careful not to catch '!=' which is already handled
    const bangIndex = exprWithMaskedBrackets.indexOf('!');
    if (bangIndex >= 0 && exprWithMaskedBrackets[bangIndex + 1] !== '=') {
        return false;
    }

    // If we passed all checks, it's likely a simple variable/lvalue
    return true;
}

/**
 * Normalize a user-entered value so it can be accepted by GDB's `set` command
 * via `interpreter-exec console`. Handles:
 * - Boolean literals: true/false -> 1/0
 * - MI-level escaping: backslashes and double quotes are escaped so the value
 *   survives the MI double-quoted wrapper intact.
 */
export function normalizeValueForGdbConsole(value: string): string {
    const lower = value.toLowerCase();
    if (lower === 'true') { return '1'; }
    if (lower === 'false') { return '0'; }

    // Escape backslashes first, then double quotes, so the value is safe inside
    // the MI `interpreter-exec console "..."` double-quoted string.
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Replace content inside square brackets with a placeholder.
 * This allows checking operators outside of array index expressions.
 * Handles nested brackets like arr[matrix[i][j]].
 */
function maskBracketContents(expr: string): string {
    let result = '';
    let depth = 0;

    for (let i = 0; i < expr.length; i++) {
        const ch = expr[i];
        if (ch === '[') {
            result += '[';
            depth++;
        } else if (ch === ']') {
            if (depth > 0) {
                result += '0'; // Add placeholder before closing
            }
            result += ']';
            depth = Math.max(0, depth - 1);
        } else if (depth === 0) {
            result += ch;
        }
        // Characters inside brackets are skipped (not added to result)
    }

    return result;
}
