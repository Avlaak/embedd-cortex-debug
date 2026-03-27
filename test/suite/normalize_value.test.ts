import * as assert from 'assert';
import { normalizeValueForGdbConsole, stripFormatSpecifier } from '../../src/common/expression-utils';

suite('normalizeValueForGdbConsole Tests', () => {
    suite('Boolean literals', () => {
        test('true -> 1', () => {
            assert.strictEqual(normalizeValueForGdbConsole('true'), '1');
        });

        test('false -> 0', () => {
            assert.strictEqual(normalizeValueForGdbConsole('false'), '0');
        });

        test('TRUE -> 1 (case-insensitive)', () => {
            assert.strictEqual(normalizeValueForGdbConsole('TRUE'), '1');
        });

        test('FALSE -> 0 (case-insensitive)', () => {
            assert.strictEqual(normalizeValueForGdbConsole('FALSE'), '0');
        });

        test('True -> 1 (mixed case)', () => {
            assert.strictEqual(normalizeValueForGdbConsole('True'), '1');
        });

        test('False -> 0 (mixed case)', () => {
            assert.strictEqual(normalizeValueForGdbConsole('False'), '0');
        });
    });

    suite('Numeric values (passed through)', () => {
        test('integer', () => {
            assert.strictEqual(normalizeValueForGdbConsole('42'), '42');
        });

        test('negative integer', () => {
            assert.strictEqual(normalizeValueForGdbConsole('-5'), '-5');
        });

        test('zero', () => {
            assert.strictEqual(normalizeValueForGdbConsole('0'), '0');
        });

        test('hex value', () => {
            assert.strictEqual(normalizeValueForGdbConsole('0xFF'), '0xFF');
        });

        test('hex value uppercase', () => {
            assert.strictEqual(normalizeValueForGdbConsole('0xDEADBEEF'), '0xDEADBEEF');
        });

        test('octal value', () => {
            assert.strictEqual(normalizeValueForGdbConsole('077'), '077');
        });

        test('floating point', () => {
            assert.strictEqual(normalizeValueForGdbConsole('3.14'), '3.14');
        });

        test('negative floating point', () => {
            assert.strictEqual(normalizeValueForGdbConsole('-2.5'), '-2.5');
        });

        test('scientific notation', () => {
            assert.strictEqual(normalizeValueForGdbConsole('1e5'), '1e5');
        });

        test('float suffix', () => {
            assert.strictEqual(normalizeValueForGdbConsole('3.14f'), '3.14f');
        });
    });

    suite('Character literals (passed through)', () => {
        test('single char', () => {
            assert.strictEqual(normalizeValueForGdbConsole("'A'"), "'A'");
        });

        test('null char', () => {
            assert.strictEqual(normalizeValueForGdbConsole("'\\0'"), "'\\\\0'");
        });
    });

    suite('String values with MI escaping', () => {
        test('double quotes are escaped', () => {
            assert.strictEqual(normalizeValueForGdbConsole('"hello"'), '\\"hello\\"');
        });

        test('backslash is escaped', () => {
            assert.strictEqual(normalizeValueForGdbConsole('C:\\path'), 'C:\\\\path');
        });

        test('backslash and quotes combined', () => {
            assert.strictEqual(normalizeValueForGdbConsole('"C:\\path"'), '\\"C:\\\\path\\"');
        });

        test('escape sequence in string', () => {
            assert.strictEqual(normalizeValueForGdbConsole('"line\\n"'), '\\"line\\\\n\\"');
        });
    });

    suite('Cast expressions (passed through)', () => {
        test('uint8 cast', () => {
            assert.strictEqual(normalizeValueForGdbConsole('(uint8_t)255'), '(uint8_t)255');
        });

        test('int cast', () => {
            assert.strictEqual(normalizeValueForGdbConsole('(int)-1'), '(int)-1');
        });
    });

    suite('Edge cases', () => {
        test('empty string', () => {
            assert.strictEqual(normalizeValueForGdbConsole(''), '');
        });

        test('trueness is not true', () => {
            assert.strictEqual(normalizeValueForGdbConsole('trueness'), 'trueness');
        });

        test('falsehood is not false', () => {
            assert.strictEqual(normalizeValueForGdbConsole('falsehood'), 'falsehood');
        });

        test('1 stays 1', () => {
            assert.strictEqual(normalizeValueForGdbConsole('1'), '1');
        });

        test('0 stays 0', () => {
            assert.strictEqual(normalizeValueForGdbConsole('0'), '0');
        });

        test('enum-like identifier', () => {
            assert.strictEqual(normalizeValueForGdbConsole('MY_ENUM_VAL'), 'MY_ENUM_VAL');
        });

        test('sizeof expression', () => {
            assert.strictEqual(normalizeValueForGdbConsole('sizeof(int)'), 'sizeof(int)');
        });
    });
});

suite('stripFormatSpecifier Tests', () => {
    suite('Strips known format suffixes', () => {
        test('hex ,h', () => {
            assert.strictEqual(stripFormatSpecifier('myVar,h'), 'myVar');
        });

        test('hex ,x', () => {
            assert.strictEqual(stripFormatSpecifier('myVar,x'), 'myVar');
        });

        test('binary ,b', () => {
            assert.strictEqual(stripFormatSpecifier('counter,b'), 'counter');
        });

        test('octal ,o', () => {
            assert.strictEqual(stripFormatSpecifier('flags,o'), 'flags');
        });

        test('decimal ,d', () => {
            assert.strictEqual(stripFormatSpecifier('reg,d'), 'reg');
        });

        test('uppercase ,H', () => {
            assert.strictEqual(stripFormatSpecifier('val,H'), 'val');
        });
    });

    suite('Preserves expressions without format', () => {
        test('simple variable', () => {
            assert.strictEqual(stripFormatSpecifier('myVar'), 'myVar');
        });

        test('struct member', () => {
            assert.strictEqual(stripFormatSpecifier('obj.field'), 'obj.field');
        });

        test('arrow member', () => {
            assert.strictEqual(stripFormatSpecifier('ptr->val'), 'ptr->val');
        });

        test('array element', () => {
            assert.strictEqual(stripFormatSpecifier('arr[0]'), 'arr[0]');
        });

        test('dereference', () => {
            assert.strictEqual(stripFormatSpecifier('*ptr'), '*ptr');
        });
    });

    suite('Does not strip format-like chars in the middle', () => {
        test('comma in expression is not stripped', () => {
            assert.strictEqual(stripFormatSpecifier('func(a,b)'), 'func(a,b)');
        });

        test('comma followed by non-format letter', () => {
            assert.strictEqual(stripFormatSpecifier('var,z'), 'var,z');
        });
    });

    suite('Struct members with format', () => {
        test('struct member with hex format', () => {
            assert.strictEqual(stripFormatSpecifier('obj.field,h'), 'obj.field');
        });

        test('arrow member with binary format', () => {
            assert.strictEqual(stripFormatSpecifier('ptr->val,b'), 'ptr->val');
        });

        test('array element with decimal format', () => {
            assert.strictEqual(stripFormatSpecifier('arr[0],d'), 'arr[0]');
        });
    });
});
