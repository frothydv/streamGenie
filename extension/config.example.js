// Copy this file to config.js and set the real SUBMIT_SECRET.
// config.js is gitignored so the value doesn't appear in the public repo.
// Note: anyone who unpacks the installed extension can still read this value —
// it is spam-prevention only. Rate limiting in the Worker is the real control.
const StreamGenieConfig = {
  SUBMIT_SECRET: "your-secret-here",
};
