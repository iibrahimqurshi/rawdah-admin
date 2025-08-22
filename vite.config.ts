import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite configuration for the Rawdah Admin project.
// This config enables the React plugin and leaves most
// options at their defaults. See https://vitejs.dev/config/
// for more details.

export default defineConfig({
  plugins: [react()],
});
