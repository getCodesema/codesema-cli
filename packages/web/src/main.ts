import { createApp } from 'vue'
import App from './App.vue'
import { t } from './i18n'
import './styles/tokens.css'
import './styles/base.css'
import './styles/kit.css'
// Legacy stylesheet: imported last so it wins until every component is migrated.
import './style.css'

const app = createApp(App)
app.config.globalProperties.$t = t
app.mount('#app')
