import styles from './shadow.module.css'
import { shadowCss } from './phone.js'

const card = document.createElement('div')
card.id = 'shadow-phone'
card.className = styles.phone
card.textContent = 'Shadow phone'
card.style.boxShadow = shadowCss
document.getElementById('root').append(card)
