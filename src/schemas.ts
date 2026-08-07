/**
 * Per-route request/response schemas published in the x402 402 challenge.
 *
 * The x402scan discovery audit reads `accepts[0].outputSchema.input` and
 * `accepts[0].outputSchema.output` from the *runtime* 402 body, and runtime
 * behaviour is authoritative — so these must not contradict openapi.json.
 * They are generated from `public/openapi.json` ($refs inlined) and keyed
 * exactly like the paywall route map, so they can be spread straight into a
 * route declaration.
 *
 * Regenerate after editing openapi.json rather than hand-editing.
 *
 * `input` follows the x402 Bazaar convention: `{ type: "http", method, ... }`
 * with `pathParams`/`queryParams` for the URL and `bodyType`/`bodyFields` for
 * routes that take a JSON body. `output` is the 200 response schema.
 */

export type RouteSchema = {
  outputSchema: {
    input: Record<string, unknown>;
    output: Record<string, unknown>;
  };
};

export const ROUTE_SCHEMAS = {
  "GET /quote": {
    outputSchema: {
      input: {
        type: "http",
        method: "GET",
        queryParams: {
          item: {
            type: "string",
            example: "court-1"
          },
          date: {
            type: "string",
            format: "date"
          },
          start: {
            type: "string",
            example: "18:00",
            description: "HH:MM, on the block grid"
          },
          end: {
            type: "string",
            example: "19:00",
            description: "HH:MM. Supply this or `blocks`."
          },
          blocks: {
            type: "integer",
            minimum: 1,
            description: "Number of blocks. Supply this or `end`."
          }
        },
        required: [
          "item",
          "date",
          "start"
        ]
      },
      output: {
        type: "object",
        description: "The purchased artifact of GET /quote. Echo it whole (signature included) into POST /reserve to pin the price.",
        properties: {
          quoteId: {
            type: "string"
          },
          itemId: {
            type: "string"
          },
          itemName: {
            type: "string"
          },
          category: {
            type: "string"
          },
          location: {
            type: "string"
          },
          date: {
            type: "string",
            format: "date"
          },
          start: {
            type: "string"
          },
          end: {
            type: "string"
          },
          blocks: {
            type: "integer"
          },
          blockMinutes: {
            type: "integer"
          },
          lines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                block: {
                  type: "string",
                  example: "18:00–18:30"
                },
                rate: {
                  type: "string",
                  example: "$0.03"
                },
                peak: {
                  type: "boolean"
                }
              }
            }
          },
          total: {
            type: "string",
            example: "$0.06"
          },
          totalAtomicUSDC: {
            type: "string",
            example: "60000"
          },
          currency: {
            type: "string",
            example: "USDC"
          },
          available: {
            type: "boolean"
          },
          unavailableReason: {
            type: "string"
          },
          reservePrice: {
            type: "string"
          },
          terms: {
            type: "string"
          },
          policy: {
            type: "string"
          },
          issuedAt: {
            type: "string",
            format: "date-time"
          },
          expiresAt: {
            type: "string",
            format: "date-time"
          },
          signature: {
            type: "string"
          }
        }
      },
    },
  },
  "POST /reserve": {
    outputSchema: {
      input: {
        type: "http",
        method: "POST",
        bodyType: "json",
        bodyFields: {
          name: {
            type: "string"
          },
          quote: {
            type: "object",
            description: "The purchased artifact of GET /quote. Echo it whole (signature included) into POST /reserve to pin the price.",
            properties: {
              quoteId: {
                type: "string"
              },
              itemId: {
                type: "string"
              },
              itemName: {
                type: "string"
              },
              category: {
                type: "string"
              },
              location: {
                type: "string"
              },
              date: {
                type: "string",
                format: "date"
              },
              start: {
                type: "string"
              },
              end: {
                type: "string"
              },
              blocks: {
                type: "integer"
              },
              blockMinutes: {
                type: "integer"
              },
              lines: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    block: {
                      type: "string",
                      example: "18:00–18:30"
                    },
                    rate: {
                      type: "string",
                      example: "$0.03"
                    },
                    peak: {
                      type: "boolean"
                    }
                  }
                }
              },
              total: {
                type: "string",
                example: "$0.06"
              },
              totalAtomicUSDC: {
                type: "string",
                example: "60000"
              },
              currency: {
                type: "string",
                example: "USDC"
              },
              available: {
                type: "boolean"
              },
              unavailableReason: {
                type: "string"
              },
              reservePrice: {
                type: "string"
              },
              terms: {
                type: "string"
              },
              policy: {
                type: "string"
              },
              issuedAt: {
                type: "string",
                format: "date-time"
              },
              expiresAt: {
                type: "string",
                format: "date-time"
              },
              signature: {
                type: "string"
              }
            }
          },
          item: {
            type: "string"
          },
          date: {
            type: "string",
            format: "date"
          },
          start: {
            type: "string"
          },
          end: {
            type: "string"
          },
          blocks: {
            type: "integer"
          }
        },
        required: [
          "name"
        ]
      },
      output: {
        type: "object",
        description: "The purchased artifact, returned in the 200 body of POST /reserve.",
        properties: {
          rentalId: {
            type: "string"
          },
          status: {
            type: "string",
            enum: [
              "confirmed"
            ]
          },
          venue: {
            type: "string"
          },
          item: {
            type: "object"
          },
          accessCode: {
            type: "string",
            description: "Gate/door/locker code, valid for the booked window only"
          },
          accessNote: {
            type: "string"
          },
          window: {
            type: "object",
            properties: {
              date: {
                type: "string",
                format: "date"
              },
              start: {
                type: "string"
              },
              end: {
                type: "string"
              },
              blocks: {
                type: "integer"
              },
              blockMinutes: {
                type: "integer"
              },
              startsAt: {
                type: "string",
                format: "date-time"
              },
              endsAt: {
                type: "string",
                format: "date-time"
              }
            }
          },
          pricing: {
            type: "object"
          },
          holder: {
            type: "string"
          },
          terms: {
            type: "object"
          },
          cancelToken: {
            type: "string"
          },
          cancelEndpoint: {
            type: "string"
          },
          quoteId: {
            type: "string"
          },
          ics: {
            type: "string",
            description: "base64-encoded RFC 5545 calendar invite"
          },
          createdAt: {
            type: "string",
            format: "date-time"
          },
          signature: {
            type: "string"
          }
        }
      },
    },
  },
} satisfies Record<string, RouteSchema>;
