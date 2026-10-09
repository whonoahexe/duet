import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google"

import "./globals.css"
import { SwRegister } from "@/components/app/sw-register"
import { ThemeProvider } from "@/components/theme-provider"
import { cn } from "@/lib/utils";

const spaceGrotesk = Space_Grotesk({subsets:['latin'],variable:'--font-sans'})

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

// PWA identity (D-08, D-10): name "duet", always dark. #090b0c is the preset's dark --background.
export const metadata: Metadata = {
  title: "duet",
  applicationName: "duet",
  appleWebApp: { capable: true, title: "duet", statusBarStyle: "black-translucent" },
  icons: { apple: "/icons/apple-touch-icon.png" },
}

export const viewport: Viewport = {
  themeColor: "#090b0c",
  viewportFit: "cover",
  colorScheme: "dark",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("dark", "antialiased", fontMono.variable, "font-sans", spaceGrotesk.variable)}
    >
      <body>
        <ThemeProvider forcedTheme="dark" defaultTheme="dark" enableSystem={false}>
          {children}
        </ThemeProvider>
        <SwRegister />
      </body>
    </html>
  )
}
