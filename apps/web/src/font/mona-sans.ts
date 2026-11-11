import localFont from 'next/font/local'

/** Mona Sans (SIL Open Font License, see OFL.txt), self-hosted: no request to third parties. */
export const monaSans = localFont({
  src: './MonaSans-VF.woff2',
  variable: '--font-mona-sans',
  display: 'swap',
  weight: '200 900',
})
