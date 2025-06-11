-- Sample SQL query for testing PlanViz
SELECT u.name, d.name as department, COUNT(o.id) as order_count, SUM(o.amount) as total_amount
	FROM users u
	JOIN departments d ON u.dept_id = d.id
	LEFT JOIN orders o ON u.id = o.user_id
	WHERE u.age > 25
	GROUP BY u.name, d.name
	ORDER BY total_amount DESC
	LIMIT 10;
