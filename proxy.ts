export { default } from "./src/proxy";

export const config = {
	matcher: [
		"/",
		"/auth/:path*",
		"/dashboard/:path*",
		"/listings/:path*",
		"/post/:path*",
		"/profile/:path*",
		"/trust/:path*",
		"/admin/:path*",
	],
};