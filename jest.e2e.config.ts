/** @jest-config-loader ts-node */
import type { Config } from 'jest';

const e2e: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/?(*.)+(spec|test).[tj]s'],
    globals: {},
    setupFiles: [
        '<rootDir>/jest.setup.ts'
    ],
    collectCoverage: true,
    collectCoverageFrom: ['src/**/*.ts'],
    coverageDirectory: 'coverage/e2e',
    coverageReporters: ['text', 'html'],
    coverageThreshold: {
        global: {
            statements: 60,
            branches: 45,
            lines: 60,
            functions: 60,
        },
    },
    // hit the built bundle, not TS source
    moduleNameMapper: {
        '^@cassina/langgraphjs-checkpoint-firestore$': '<rootDir>/dist/index.js',
        '^@cassina/langgraphjs-checkpoint-firestore/(.*)$': '<rootDir>/dist/$1',
    },
};

export default e2e;
