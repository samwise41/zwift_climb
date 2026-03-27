export default function handler(req, res) {
  const clientID = process.env.STRAVA_CLIENT_ID;
  const redirectURI = `${process.env.NEXT_PUBLIC_BASE_URL}/api/callback`;
  const scope = "activity:read_all";
  
  const authUrl = `https://www.strava.com/oauth/authorize?client_id=${clientID}&redirect_uri=${redirectURI}&response_type=code&scope=${scope}`;
  
  res.redirect(authUrl);
}
