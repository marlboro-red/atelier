import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'tests/browser',timeout:45000,workers:1,use:{baseURL:'http://127.0.0.1:14310',viewport:{width:1440,height:1000},trace:'retain-on-failure'},webServer:{command:'ATELIER_PORT=14310 ATELIER_DATA_DIR=.atelier/test npm start',url:'http://127.0.0.1:14310/api/health',reuseExistingServer:false,timeout:30000}});
