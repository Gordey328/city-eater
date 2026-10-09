import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./browser-tests',timeout:120000,expect:{timeout:30000},workers:1,
  use:{baseURL:'http://127.0.0.1:4173',headless:true,viewport:{width:1280,height:800},trace:'retain-on-failure'},
  webServer:{command:'npm run dev -- --host 127.0.0.1 --port 4173',url:'http://127.0.0.1:4173',reuseExistingServer:!process.env.CI},
});
