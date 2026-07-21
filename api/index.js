// Vercel serverless entry point
// Imports the Express app from server.js — Vercel handles the HTTP layer
const app = require('../server');

module.exports = app;
