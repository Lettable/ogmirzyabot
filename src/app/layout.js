import "./globals.css"

export const metadata = {
  title: "OgMirza",
  description: "Mass reporting platform",
}

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="dark">
      <body>
        <div id="app-zoom">{children}</div>
      </body>
    </html>
  )
}
