import api from "./api";

export async function fetchTrafficDashboardData(days = 30) {
  const [trafficRes, topRes, overviewRes] = await Promise.all([
    api.get(`/stats/traffic?days=${days}`),
    api.get("/stats/top?limit=10"),
    api.get("/stats/overview"),
  ]);

  return {
    trafficData: trafficRes.data?.success ? trafficRes.data.data : [],
    topImages: topRes.data?.success ? topRes.data.data : [],
    overview: overviewRes.data?.success ? overviewRes.data.data : null,
  };
}
