/** @jest-config-loader ts-node */
import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/?(*.)+(spec|test).[tj]s'],
    globals: {},
    setupFiles: [
        '<rootDir>/jest.setup.ts'
    ],
    collectCoverage: true,
    collectCoverageFrom: ['src/**/*.ts'],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'html'],
    coverageThreshold: {
        global: {
            statements: 80,
            branches: 60,
            lines: 80,
            functions: 80,
        },
    },
};

export default config;
