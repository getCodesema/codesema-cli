import { createApp } from 'vue'
import App from './App.vue'
import { t } from './i18n'
import './styles/tokens.css'
import './styles/base.css'
import './styles/kit.css'

const app = createApp(App)
app.config.globalProperties.$t = t
app.mount('#app')
