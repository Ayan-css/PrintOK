import { createApp } from './app';

const PORT = process.env.PORT || 4000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`[PrintOk Cloud API] Listening on http://localhost:${PORT}`);
});
