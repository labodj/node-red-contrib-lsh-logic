module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  coveragePathIgnorePatterns: ["/src/__tests__/helpers/"],
};
