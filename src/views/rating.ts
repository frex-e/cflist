type RatingTitle = {
  name: string;
  className: string;
  textClassName: string;
};

export const ratingTitle = (rating: number | null): RatingTitle => {
  if (rating === null) return { name: "Unrated", className: "rank-unrated", textClassName: "rating-unrated" };
  if (rating < 1200) return { name: "Newbie", className: "rank-newbie", textClassName: "rating-newbie" };
  if (rating < 1400) return { name: "Pupil", className: "rank-pupil", textClassName: "rating-pupil" };
  if (rating < 1600) return { name: "Specialist", className: "rank-specialist", textClassName: "rating-specialist" };
  if (rating < 1900) return { name: "Expert", className: "rank-expert", textClassName: "rating-expert" };
  if (rating < 2100) return { name: "Candidate Master", className: "rank-candidate-master", textClassName: "rating-candidate-master" };
  if (rating < 2300) return { name: "Master", className: "rank-master", textClassName: "rating-master" };
  if (rating < 2400) return { name: "International Master", className: "rank-international-master", textClassName: "rating-international-master" };
  if (rating < 2600) return { name: "Grandmaster", className: "rank-grandmaster", textClassName: "rating-grandmaster" };
  if (rating < 3000) return { name: "International Grandmaster", className: "rank-international-grandmaster", textClassName: "rating-international-grandmaster" };
  return { name: "Legendary Grandmaster", className: "rank-legendary-grandmaster", textClassName: "rating-legendary-grandmaster" };
};
