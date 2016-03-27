#! /usr/bin/env node
'use strict'; // eslint-disable-line

const fs = require('fs');
const _ = require('lodash');
const path = require('path');
const gutil = require('gulp-util');
const babel = require('babel-core');
const desc = `
  Tranforms script with Babel using application's config.
  Usage: $0 <file> [options]

  By default transpiles script for server.
  Use -c option to specify another config`;

const argv = require('yargs')
    .usage(desc)
    .options({
        'c': {
            describe: 'Config for transformation. Default is config for server',
            default: path.join(__dirname, 'server.config.js'),
            alias: 'config',
            type: 'string'
        },
        'f': {
            describe: 'File to transform',
            demand: true,
            alias: 'file',
            type: 'string'
        },
        'o': {
            describe: 'File to save transformed script into',
            alias: 'out',
            type: 'string'
        }
    })
    .check(argv => {
        if (!fs.existsSync(argv.file)) {
            throw new Error(`File "${argv.file}" doesn't exist`);
        }

        return true;
    })
    .help('help')
    .showHelpOnFail(false, 'Run with `--help` to see usage example')
    .argv;

const input = fs.readFileSync(argv.file, 'utf8');
const config = require(path.resolve(argv.config));
const start = Date.now();
const output = babel.transform(input, config);
const end = Date.now() - start;
const inputSize = Buffer.byteLength(input, 'utf8');
const outputSize = Buffer.byteLength(output.code, 'utf8');

/* eslint no-console:0 */
if (argv.out) {
    fs.writeFileSync(argv.out, output.code);
    console.log(gutil.colors.green(`File "${argv.file}" transpiled into "${argv.out}"`));
} else {
    console.log(output.code);
    console.log('---------');
}

console.log(
    `time: ${gutil.colors.yellow(`${end}ms`)},`,
    `inputSize: ${gutil.colors.yellow(inputSize)}, outputSize: ${gutil.colors.yellow(outputSize)}\n`,
    `config: ${gutil.colors.yellow(argv.config)}\n`,
    `usedHelpers: ${_.map(output.metadata.usedHelpers, helper => gutil.colors.yellow(helper)).join(', ') || '—'}`
);