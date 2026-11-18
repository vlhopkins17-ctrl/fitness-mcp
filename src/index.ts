import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { neon } from '@neondatabase/serverless';
import { z } from 'zod';
import { config } from 'dotenv';

config({ path: '.env.local' });

const sql = neon(process.env.DATABASE_URL!);

// Helper to create a fresh McpServer instance per stateless HTTP request
function createFitnessServer() {
  const server = new McpServer({
    name: 'fitness-nutrition-mcp',
    version: '1.0.0',
  });

  // Tool 1: Look up verified nutrition facts via Open Food Facts API
  server.tool(
    'lookup_nutrition_facts',
    'Search external nutrition database for verified calories and macronutrients per 100g of a food item.',
    {
      query: z.string().describe('Food name to search, e.g. "chicken breast", "oats", "banana"'),
    },
    async ({ query }) => {
      const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(
        query
      )}&search_simple=1&action=process&json=1&page_size=3`;

      const response = await fetch(url, {
        headers: { 'User-Agent': 'ValereFitnessAgent/1.0' },
      });
      const data = await response.json();

      const products = (data.products || []).map((p: any) => ({
        name: p.product_name || query,
        brand: p.brands || 'Generic',
        per100g: {
          calories: Math.round(p.nutriments?.['energy-kcal_100g'] || 0),
          proteinGrams: Number((p.nutriments?.proteins_100g || 0).toFixed(1)),
          carbsGrams: Number((p.nutriments?.carbohydrates_100g || 0).toFixed(1)),
          fatGrams: Number((p.nutriments?.fat_100g || 0).toFixed(1)),
        },
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify(products, null, 2) }],
      };
    }
  );

  // Tool 2: Log a Meal to Neon Postgres
  server.tool(
    'log_meal',
    'Save a logged meal with calories and macronutrients into the Neon database.',
    {
      foodName: z.string().describe('Name/description of the meal'),
      calories: z.number().int().describe('Total calories'),
      proteinGrams: z.number().describe('Protein in grams'),
      carbsGrams: z.number().describe('Carbohydrates in grams'),
      fatGrams: z.number().describe('Fat in grams'),
      mealType: z.string().optional().describe('breakfast, lunch, dinner, or snack'),
    },
    async ({ foodName, calories, proteinGrams, carbsGrams, fatGrams, mealType }) => {
      const rows = await sql`
        INSERT INTO meals (food_name, calories, protein_grams, carbs_grams, fat_grams, meal_type)
        VALUES (${foodName}, ${calories}, ${proteinGrams}, ${carbsGrams}, ${fatGrams}, ${mealType ?? null})
        RETURNING id, food_name, calories, protein_grams
      `;

      const row = rows[0];
      if (!row) {
        throw new Error('Failed to log meal');
      }

      return {
        content: [
          {
            type: 'text',
            text: `Logged meal #${row.id}: ${row.food_name} (${row.calories} kcal, ${row.protein_grams}g protein)`,
          },
        ],
      };
    }
  );

  // Tool 3: Get Today's Total Calories & Macros
  server.tool(
    'get_daily_macros',
    'Calculate total calories, protein, carbs, and fat logged today.',
    {},
    async () => {
      const rows = await sql`
        SELECT
          COUNT(*)::int AS meal_count,
          COALESCE(SUM(calories), 0)::int AS total_calories,
          COALESCE(SUM(protein_grams), 0)::float AS total_protein,
          COALESCE(SUM(carbs_grams), 0)::float AS total_carbs,
          COALESCE(SUM(fat_grams), 0)::float AS total_fat
        FROM meals
        WHERE logged_at >= CURRENT_DATE
      `;

      return {
        content: [{ type: 'text', text: JSON.stringify(rows[0], null, 2) }],
      };
    }
  );

  // Tool 4: Log a Workout Set/Session to Neon Postgres
  server.tool(
    'log_workout',
    'Save a completed exercise or workout session to the Neon database.',
    {
      exercise: z.string().describe('Exercise name, e.g. "Barbell Bench Press" or "Cycling"'),
      sets: z.number().int().default(1).describe('Number of sets'),
      reps: z.number().int().default(1).describe('Reps per set'),
      weightLbs: z.number().optional().describe('Weight used in pounds, if applicable'),
      durationMinutes: z.number().int().optional().describe('Duration in minutes, if applicable'),
      notes: z.string().optional().describe('Form cues, RPE, or recovery notes'),
    },
    async ({ exercise, sets, reps, weightLbs, durationMinutes, notes }) => {
      const rows = await sql`
        INSERT INTO workouts (exercise, sets, reps, weight_lbs, duration_minutes, notes)
        VALUES (${exercise}, ${sets}, ${reps}, ${weightLbs ?? null}, ${durationMinutes ?? null}, ${notes ?? null})
        RETURNING id, exercise, sets, reps, weight_lbs
      `;

      const row = rows[0];
      if (!row) {
        throw new Error('Failed to log workout');
      }

      return {
        content: [
          {
            type: 'text',
            text: `Logged workout #${row.id}: ${row.exercise} (${row.sets}x${row.reps}${
              row.weight_lbs ? ` @ ${row.weight_lbs} lbs` : ''
            })`,
          },
        ],
      };
    }
  );

  // Tool 5: Retrieve Recent Workouts
  server.tool(
    'get_recent_workouts',
    'Fetch the last 10 logged workouts to review training history and suggest progressive overload.',
    {},
    async () => {
      const rows = await sql`
        SELECT id, exercise, sets, reps, weight_lbs, duration_minutes, notes, logged_at
        FROM workouts
        ORDER BY logged_at DESC
        LIMIT 10
      `;

      return {
        content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
      };
    }
  );

  return server;
}

const app = express();
app.use(cors());
app.use(express.json());

// Health check route for cloud hosting
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', server: 'fitness-nutrition-mcp' });
});

// Stateless Streamable HTTP MCP Endpoint
app.post('/mcp', async (req, res) => {
  try {
    const server = createFitnessServer();
    const transport = new StreamableHTTPServerTransport({});

    res.on('close', () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP HTTP Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal MCP server error' });
    }
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Fitness MCP Server running on http://localhost:${PORT}/mcp`);
});
